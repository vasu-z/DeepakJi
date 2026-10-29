/**
 * Saarthi Live Camera Assist Service — Live Scene Understanding for Blind/Low-Vision Users.
 *
 * Implements:
 * 1. Explicit session lifecycle: idle -> requesting_permissions -> connecting -> active -> paused -> error -> stopping -> idle.
 * 2. Spoken activation announcement: "Saarthi scene understanding is on. Point your camera around; ask me anything."
 * 3. Rear-camera stream and capture start only after explicit activation.
 * 4. Low-latency WebSocket Live session with automatic graceful fallback to verified REST endpoint.
 * 5. Grounded visual object search ("Where are my keys?"):
 *    - Frame-relative positions only (e.g. "near the lower-left side of the table").
 *    - Bounded camera sweep guidance when object is not yet found without endless audio loops.
 *    - Absolute prohibition on hallucinated physical distances.
 * 6. Proactive narration with token similarity duplicate suppression.
 * 7. Instant barge-in / interruption: user speech or stop tap halts speech immediately and cancels in-flight work.
 * 8. Guaranteed deterministic cleanup of camera, microphone, timers, and sockets on stop.
 */

import { speechService } from "./speech";
import { hapticsService } from "./haptics";
import {
  analyzeSceneAssist,
  createSceneLiveWebSocket,
  GroundedObjectSearchResult,
  SceneAnalysisResponse,
  SceneLiveWebSocketSession,
} from "../api/client";

export type LiveAssistStatus =
  | "idle"
  | "requesting_permissions"
  | "connecting"
  | "active"
  | "paused"
  | "error"
  | "stopping";

export interface LiveAssistObservation {
  description: string;
  timestamp: number;
  confidence: number;
  quality: string;
}

export interface LiveAssistState {
  status: LiveAssistStatus;
  isSamplingActive: boolean;
  isAnalyzing: boolean;
  latestDescription: string;
  latestConfidence: number;
  latestImageQuality: string;
  error: string | null;
  suppressedCount: number;
  activeTargetObject: string | null;
  isSearching: boolean;
  lastSearchResult: GroundedObjectSearchResult | null;
  connectionMode: "live_websocket" | "rest_fallback";
}

export type LiveAssistStateListener = (state: LiveAssistState) => void;

/**
 * Stop words excluded when computing token similarity for duplicate suppression.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is",
  "are", "was", "were", "there", "you", "your", "front", "ahead", "with",
]);

/**
 * Compute Jaccard token similarity between two spoken descriptions.
 */
export function computeDescriptionSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0;
  const tokensA = new Set(
    textA
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
  const tokensB = new Set(
    textB
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );

  if (tokensA.size === 0 || tokensB.size === 0) {
    return textA.trim().toLowerCase() === textB.trim().toLowerCase() ? 1.0 : 0;
  }

  let intersectionSize = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      intersectionSize++;
    }
  }

  const unionSize = new Set([...tokensA, ...tokensB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export class LiveAssistService {
  private status: LiveAssistStatus = "idle";
  private isSamplingActive: boolean = false;
  private isAnalyzing: boolean = false;
  private latestDescription: string = "";
  private latestConfidence: number = 0;
  private latestImageQuality: string = "adequate";
  private error: string | null = null;
  private suppressedCount: number = 0;
  private activeTargetObject: string | null = null;
  private isSearching: boolean = false;
  private lastSearchResult: GroundedObjectSearchResult | null = null;
  private connectionMode: "live_websocket" | "rest_fallback" = "live_websocket";

  // Target object search bounded sweep tracking
  private searchSweepAttempts: number = 0;
  private readonly MAX_SWEEP_ATTEMPTS = 5;

  private activeAbortController: AbortController | null = null;
  private sampleTimer: ReturnType<typeof setTimeout> | null = null;
  private recentObservations: LiveAssistObservation[] = [];
  private listeners: Set<LiveAssistStateListener> = new Set();
  private wsSession: SceneLiveWebSocketSession | null = null;

  private frameCaptureFn: (() => Promise<{ base64?: string; mimeType?: string } | null>) | null = null;
  private pendingQueryResolve: ((desc: string) => void) | null = null;

  // Configuration (adapted from RealTimeAICam & Nux live cadence)
  private readonly SAMPLING_INTERVAL_MS = 2500; // 2.5 seconds between automatic samples for responsive rotation
  private readonly DUPLICATE_COOLDOWN_MS = 12000; // 12 seconds cooldown for identical scene view
  private readonly SIMILARITY_THRESHOLD = 0.65; // 65% token overlap considered duplicate

  public registerFrameCapture(
    captureFn: (() => Promise<{ base64?: string; mimeType?: string } | null>) | null
  ): void {
    this.frameCaptureFn = captureFn;
  }

  public getState(): LiveAssistState {
    return {
      status: this.status,
      isSamplingActive: this.isSamplingActive,
      isAnalyzing: this.isAnalyzing,
      latestDescription: this.latestDescription,
      latestConfidence: this.latestConfidence,
      latestImageQuality: this.latestImageQuality,
      error: this.error,
      suppressedCount: this.suppressedCount,
      activeTargetObject: this.activeTargetObject,
      isSearching: this.isSearching,
      lastSearchResult: this.lastSearchResult,
      connectionMode: this.connectionMode,
    };
  }

  public subscribe(listener: LiveAssistStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.warn("[LiveAssistService] Listener error:", err);
      }
    });
  }

  private frameSeq: number = 0;

  /**
   * Start live scene understanding session.
   * Requirement A: Speaks explicit short confirmation.
   */
  public async startLiveAssist(): Promise<void> {
    if (this.isSamplingActive && this.status === "active") return;

    this.status = "connecting";
    this.isSamplingActive = true;
    this.error = null;
    this.searchSweepAttempts = 0;
    this.notify();

    await hapticsService.triggerButtonPress();

    // Spoken activation announcement mandated by Feature 01 specification
    const activationSpeech =
      "Saarthi scene understanding is on. Point your camera around; ask me anything.";
    await speechService.speak(activationSpeech, { force: true });

    // Try initiating WebSocket live connection
    this.initWebSocketSession();

    this.status = "active";
    this.notify();

    // Initial capture and concise scene observation
    this.scheduleInitialObservation(1400);
  }

  private scheduleInitialObservation(delayMs: number): void {
    this.clearSampleTimer();
    this.sampleTimer = setTimeout(async () => {
      if (this.isSamplingActive && !this.isAnalyzing && this.status === "active") {
        console.log("[DIAGNOSTIC INIT] Executing initial concise scene observation...");
        await this.describeNow("Describe what is visibly in front of me in 1 to 2 concise sentences.");
      }
    }, delayMs);
  }

  /**
   * Initialize server-managed WebSocket session for live streaming.
   */
  private initWebSocketSession(): void {
    if (this.wsSession) {
      try {
        this.wsSession.close();
      } catch {
        // Safe ignore
      }
      this.wsSession = null;
    }

    try {
      this.wsSession = createSceneLiveWebSocket({
        onSessionState: (state) => {
          if (state.status === "active") {
            this.connectionMode = "live_websocket";
            this.notify();
          }
        },
        onDescription: (desc) => {
          this.handleLiveDescription(desc.spokenDescription, desc.confidence, desc.imageQuality);
        },
        onSearchResult: (result) => {
          this.handleLiveSearchResult(result);
        },
        onError: (err) => {
          this.connectionMode = "rest_fallback";
          this.error = err.error;
          if (err.spokenDescription) {
            speechService.speak(err.spokenDescription, { force: true });
          } else if (err.error && err.recoverable === false) {
            speechService.speak(err.error, { force: true });
          }
          this.notify();
        },
        onClosed: () => {
          this.connectionMode = "rest_fallback";
          this.notify();
        },
      });

      this.wsSession.activate(this.activeTargetObject || undefined);
    } catch {
      this.connectionMode = "rest_fallback";
    }
  }

  /**
   * Pause sampling without discarding history.
   */
  public async pauseLiveAssist(): Promise<void> {
    this.isSamplingActive = false;
    this.status = "paused";
    this.clearSampleTimer();
    this.abortInFlight();

    if (this.wsSession) {
      this.wsSession.pause();
    }

    this.notify();
    await speechService.speak("Scene understanding paused. Tap resume or tap top-right to continue.", {
      force: true,
    });
  }

  /**
   * Resume sampling.
   */
  public async resumeLiveAssist(): Promise<void> {
    if (this.isSamplingActive && this.status === "active") return;
    this.isSamplingActive = true;
    this.status = "active";
    this.error = null;

    if (this.wsSession) {
      this.wsSession.resume();
    }

    this.notify();
    await speechService.speak("Scene understanding resumed.", { force: true });
    this.scheduleNextSample(500);
  }

  /**
   * Immediate STOP: cuts off speech, aborts in-flight request, stops streams,
   * releases all timers and sockets cleanly.
   */
  public async stop(): Promise<void> {
    this.status = "stopping";
    this.isSamplingActive = false;
    this.isAnalyzing = false;
    this.isSearching = false;
    this.activeTargetObject = null;
    this.searchSweepAttempts = 0;
    this.clearSampleTimer();
    this.abortInFlight();

    if (this.wsSession) {
      try {
        this.wsSession.stop();
        this.wsSession.close();
      } catch {
        // Safe ignore
      }
      this.wsSession = null;
    }

    // Immediately stop audible speech
    await speechService.stop();

    this.status = "idle";
    this.notify();

    // Spoken audible confirmation of complete shutdown
    await speechService.speak("Scene understanding stopped.", { force: true });
  }

  /**
   * Targeted visual search: "Where are my keys?".
   * Uses recent/current active camera frames with frame-relative grounding.
   */
  public async searchTargetObject(targetObject: string): Promise<string> {
    const target = targetObject.trim();
    if (!target) return "";

    // Immediate speech cutoff (barge-in)
    await speechService.stop();

    if (this.activeTargetObject !== target) {
      this.activeTargetObject = target;
      this.searchSweepAttempts = 0;
    }
    this.isSearching = true;
    this.notify();

    return await this.executeAnalysisCycle(`Where are my ${target}?`, true, target);
  }

  /**
   * Explicit on-demand scene description ("Describe Now", "What is ahead?").
   */
  public async describeNow(query?: string): Promise<string> {
    // Immediate barge-in cutoff
    void speechService.stop();

    if (query && (query.toLowerCase().includes("where") || query.toLowerCase().includes("find"))) {
      const match = query.match(/(?:where (?:is|are)|find)\s+(?:my|the|a)?\s*([a-z0-9\s]+)/i);
      if (match && match[1]) {
        return await this.searchTargetObject(match[1].trim());
      }
    }

    return await this.executeAnalysisCycle(
      query || "Describe what is visibly in front of me.",
      true,
      this.activeTargetObject || undefined
    );
  }

  /**
   * Check for meaningful visual changes ("What changed?").
   */
  public async whatChanged(): Promise<string> {
    void speechService.stop();
    return await this.executeAnalysisCycle("What changed?", true);
  }

  /**
   * Core analysis execution cycle with single-request concurrency.
   */
  private async executeAnalysisCycle(
    query?: string,
    isUserForced: boolean = false,
    targetObject?: string
  ): Promise<string> {
    if (this.isAnalyzing) {
      console.log("[LiveAssistService] Skipped cycle: analysis already in flight.");
      return "An analysis is already in progress. Please wait.";
    }

    if (!this.frameCaptureFn) {
      const msg = "Camera preview is not active.";
      this.error = msg;
      this.notify();
      if (isUserForced) {
        await speechService.speak(msg, { force: true });
      }
      return msg;
    }

    this.isAnalyzing = true;
    this.error = null;
    this.notify();

    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      // 1. Capture actual camera frame with retry
      let frame = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        frame = await this.frameCaptureFn();
        if (frame && frame.base64) break;
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 300));
      }

      if (!frame || !frame.base64) {
        throw new Error("Could not capture camera frame. Camera may be busy or initializing.");
      }

      if (controller.signal.aborted) {
        throw new Error("Analysis aborted by user.");
      }

      // If live WebSocket is connected, relay frame and query over WebSocket
      if (this.wsSession && this.wsSession.isConnected()) {
        this.frameSeq++;
        console.log(`[DIAGNOSTIC CAPTURE] Frame seq=${this.frameSeq}, b64_len=${frame.base64.length}, query="${query || ''}", target="${targetObject || ''}"`);
        this.wsSession.sendFrame(frame.base64, frame.mimeType || "image/jpeg", this.frameSeq);
        if (query || targetObject) {
          this.wsSession.sendQuery(query || "", targetObject || this.activeTargetObject || undefined, frame.base64, frame.mimeType || "image/jpeg");
          const wsResponse = await Promise.race([
            new Promise<string>((resolve) => {
              this.pendingQueryResolve = resolve;
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000)),
          ]);
          if (wsResponse) {
            console.log(`[DIAGNOSTIC DELIVERY] WebSocket response resolved: "${wsResponse}"`);
            this.isAnalyzing = false;
            this.notify();
            return wsResponse;
          }
        } else {
          // Continuous scene narration frame: wait up to 4s for server description response
          const wsResponse = await Promise.race([
            new Promise<string>((resolve) => {
              this.pendingQueryResolve = resolve;
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
          ]);
          this.isAnalyzing = false;
          this.notify();
          if (wsResponse) {
            console.log(`[DIAGNOSTIC DELIVERY] WebSocket live scene description received: "${wsResponse}"`);
            return wsResponse;
          }
          return this.latestDescription || "Scene understanding active.";
        }
      }

      // 2. Perform REST analysis as the guaranteed fallback / primary grounded engine
      const prevDesc = this.recentObservations.length > 0
        ? this.recentObservations[this.recentObservations.length - 1].description
        : undefined;

      const result: SceneAnalysisResponse = await analyzeSceneAssist(
        frame.base64,
        query,
        frame.mimeType || "image/jpeg",
        controller.signal,
        targetObject || this.activeTargetObject || undefined,
        prevDesc
      );

      if (controller.signal.aborted) {
        throw new Error("Analysis aborted by user.");
      }

      this.latestDescription = result.spoken_description;
      this.latestConfidence = result.confidence;
      this.latestImageQuality = result.image_quality;

      // 3. Handle targeted object search result
      if (result.search_result) {
        this.lastSearchResult = result.search_result;
        return this.handleSearchResultOutcome(result.search_result, isUserForced);
      }

      // 4. Handle unreadable or blurry image honestly
      if (result.needs_rescan || result.image_quality === "poor" || result.image_quality === "unreadable") {
        const unclearMsg =
          "Image is too blurry or dark to read details clearly. Please hold steady and improve lighting.";
        this.latestDescription = unclearMsg;
        this.notify();
        await speechService.speak(unclearMsg, { force: isUserForced });
        return unclearMsg;
      }

      // 5. Duplicate announcement suppression
      const shouldSpeak = isUserForced || !this.isDuplicateAnnouncement(result.spoken_description);

      if (shouldSpeak) {
        this.recordObservation(result.spoken_description, result.confidence, result.image_quality);
        this.notify();
        await speechService.speak(result.spoken_description, { force: isUserForced });
      } else {
        this.suppressedCount++;
        console.log(`[LiveAssistService] Duplicate announcement suppressed (${this.suppressedCount})`);
        this.notify();
      }

      return result.spoken_description;
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        console.log("[LiveAssistService] Analysis cycle safely aborted.");
        return "Analysis stopped.";
      }

      const errMsg =
        err?.message ||
        "Unable to connect to vision service. Please check your network connection.";
      this.error = errMsg;
      this.notify();

      if (isUserForced) {
        await speechService.speak(errMsg, { force: true });
      }
      return errMsg;
    } finally {
      this.isAnalyzing = false;
      this.activeAbortController = null;
      this.notify();

      // Schedule next sample if still active
      if (this.isSamplingActive && this.status === "active") {
        this.scheduleNextSample(this.SAMPLING_INTERVAL_MS);
      }
    }
  }

  private async handleSearchResultOutcome(
    result: GroundedObjectSearchResult,
    isUserForced: boolean
  ): Promise<string> {
    if (result.is_found) {
      // Object found! Announce grounded frame-relative position and finish search
      this.isSearching = false;
      this.activeTargetObject = null;
      this.searchSweepAttempts = 0;
      this.notify();
      await speechService.speak(result.spoken_description, { force: true });
      return result.spoken_description;
    } else {
      // Object not yet found in current frame
      this.searchSweepAttempts++;

      if (this.searchSweepAttempts >= this.MAX_SWEEP_ATTEMPTS) {
        // Bounded search limit reached: offer to pause rather than spamming continuously
        const limitMsg = `I still can't see the ${result.target_object} in this area. Move to another surface and ask again.`;
        this.isSearching = false;
        this.activeTargetObject = null;
        this.searchSweepAttempts = 0;
        this.notify();
        await speechService.speak(limitMsg, { force: true });
        return limitMsg;
      }

      // Initial sweep guidance
      const guidance = result.spoken_description;
      this.notify();
      await speechService.speak(guidance, { force: isUserForced || this.searchSweepAttempts === 1 });
      return guidance;
    }
  }

  private handleLiveDescription(
    description?: string,
    confidence?: number,
    imageQuality?: string
  ): void {
    if (!description || !this.isSamplingActive) return;
    this.latestDescription = description;
    if (confidence !== undefined) this.latestConfidence = confidence;
    if (imageQuality) this.latestImageQuality = imageQuality;

    const hadPendingQuery = Boolean(this.pendingQueryResolve);
    if (this.pendingQueryResolve) {
      this.pendingQueryResolve(description);
      this.pendingQueryResolve = null;
    }

    const isDup = !hadPendingQuery && this.isDuplicateAnnouncement(description);
    if (!isDup) {
      this.recordObservation(description, this.latestConfidence, this.latestImageQuality);
      this.notify();
      speechService.speak(description, { force: hadPendingQuery });
    } else {
      this.suppressedCount++;
      this.notify();
    }
  }

  private handleLiveSearchResult(result: GroundedObjectSearchResult): void {
    if (!this.isSamplingActive) return;
    this.lastSearchResult = result;
    this.latestDescription = result.spoken_description;

    if (this.pendingQueryResolve) {
      this.pendingQueryResolve(result.spoken_description);
      this.pendingQueryResolve = null;
    }

    this.handleSearchResultOutcome(result, true);
  }

  /**
   * Checks whether the new observation is substantially identical to a recent observation.
   */
  public isDuplicateAnnouncement(newDescription: string): boolean {
    if (!newDescription || newDescription.trim().length === 0) return true;
    const now = Date.now();

    for (const obs of this.recentObservations) {
      const ageMs = now - obs.timestamp;
      if (ageMs > this.DUPLICATE_COOLDOWN_MS) continue;

      const similarity = computeDescriptionSimilarity(newDescription, obs.description);
      if (similarity >= this.SIMILARITY_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  private recordObservation(description: string, confidence: number, quality: string): void {
    const now = Date.now();
    this.recentObservations.push({
      description,
      timestamp: now,
      confidence,
      quality,
    });

    if (this.recentObservations.length > 10) {
      this.recentObservations.shift();
    }
  }

  private scheduleNextSample(delayMs: number): void {
    this.clearSampleTimer();
    this.sampleTimer = setTimeout(async () => {
      if (this.isSamplingActive && !this.isAnalyzing && this.status === "active") {
        await this.executeAnalysisCycle(undefined, false, this.activeTargetObject || undefined);
      }
    }, delayMs);
  }

  private clearSampleTimer(): void {
    if (this.sampleTimer) {
      clearTimeout(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private abortInFlight(): void {
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        // Safe ignore
      }
      this.activeAbortController = null;
    }
  }

  /**
   * Cleanup all resources upon unmount or screen blur.
   */
  public cleanup(): void {
    this.status = "idle";
    this.isSamplingActive = false;
    this.clearSampleTimer();
    this.abortInFlight();
    this.isAnalyzing = false;
    this.isSearching = false;
    this.activeTargetObject = null;
    this.searchSweepAttempts = 0;
    if (this.wsSession) {
      try {
        this.wsSession.close();
      } catch {
        // Safe ignore
      }
      this.wsSession = null;
    }
    this.listeners.clear();
    this.recentObservations = [];
  }
}

export const liveAssistService = new LiveAssistService();
