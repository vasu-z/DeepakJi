import { getBackendBaseUrl, setBackendBaseUrl, CANDIDATE_BACKEND_URLS } from "../config/env";

export { getBackendBaseUrl as getApiBaseUrl, setBackendBaseUrl as setCustomApiBaseUrl };
export { checkAIStatus as getAiStatus };

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
}

export interface AIStatusResponse {
  configured: boolean;
  model: string;
  mock_mode?: boolean;
}

export interface AITestResponse {
  status: string;
  model: string;
  prompt: string;
  response: string;
}

export interface AIVisionResponse {
  status: string;
  model: string;
  prompt: string;
  description: string;
  confidence?: number;
  uncertainties?: string[];
  unchecked_areas?: string[];
  needs_rescan?: boolean;
  extracted_text?: string;
}

export interface DetectedObject {
  label: string;
  relative_position?: string;
  confidence: number;
}

export interface DetectedTextItem {
  text: string;
  context?: string;
  confidence: number;
}

export interface GroundedObjectSearchResult {
  is_found: boolean;
  target_object: string;
  relative_frame_position?: string;
  confidence: number;
  next_action: "located" | "sweep_camera" | "improve_lighting" | "continue_scanning";
  spoken_description: string;
}

export interface SceneAnalysisResponse {
  status: string;
  model: string;
  spoken_description: string;
  objects: DetectedObject[];
  detected_texts: DetectedTextItem[];
  search_result?: GroundedObjectSearchResult;
  spatial_description?: string;
  uncertainties: string[];
  unchecked_areas: string[];
  image_quality: string;
  needs_rescan: boolean;
  confidence: number;
}

export interface TimetableItem {
  course_code: string;
  course_name: string;
  day_of_week: string;
  start_time: string;
  end_time: string;
  room: string;
  building?: string;
  confidence: number;
}

export interface DoorSignInfo {
  room_number: string;
  department?: string;
  occupants: string[];
  status?: string;
  confidence: number;
}

export interface NoticeItem {
  title: string;
  raw_date_text?: string;
  summary: string;
  urgency: string;
  confidence: number;
}

export interface CampusReadingResponse {
  status: string;
  reading_mode: string;
  spoken_summary: string;
  confidence: number;
  needs_rescan: boolean;
  source_text: string;
  door_sign?: DoorSignInfo;
  timetable_items: TimetableItem[];
  notices: NoticeItem[];
  uncertainties: string[];
  unchecked_areas: string[];
}

export interface ApiError {
  message: string;
  statusCode?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      const err = new Error("Request was cancelled by user.");
      err.name = "AbortError";
      throw err;
    }
    externalSignal.addEventListener("abort", () => {
      controller.abort();
    });
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    return response;
  } catch (error: any) {
    if (externalSignal?.aborted) {
      const cancelErr = new Error("Request cancelled.");
      cancelErr.name = "AbortError";
      throw cancelErr;
    }

    // Auto-failover: if this was a backend URL request that failed due to network / connectivity issues,
    // seamlessly probe the remaining candidates to find the live connection (e.g. USB ADB reverse vs Wi-Fi).
    const currentBase = getBackendBaseUrl();
    if (url.startsWith(currentBase)) {
      const pathAndQuery = url.slice(currentBase.length);
      const candidates = CANDIDATE_BACKEND_URLS.filter((c) => c !== currentBase);
      for (const candidate of candidates) {
        if (externalSignal?.aborted) break;
        try {
          const fallbackUrl = `${candidate}${pathAndQuery}`;
          const fallbackCtrl = new AbortController();
          const fallbackTimer = setTimeout(() => fallbackCtrl.abort(), Math.min(timeoutMs, 2500));
          if (externalSignal) {
            externalSignal.addEventListener("abort", () => fallbackCtrl.abort());
          }
          const fbResponse = await fetch(fallbackUrl, {
            ...options,
            signal: fallbackCtrl.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(options.headers || {}),
            },
          });
          clearTimeout(fallbackTimer);
          if (fbResponse) {
            setBackendBaseUrl(candidate);
            console.log(`[SAARTHI Client] Auto-recovered backend connection via: ${candidate}`);
            return fbResponse;
          }
        } catch {
          // Probe next candidate
        }
      }
    }

    if (error.name === "AbortError") {
      if (timedOut) {
        throw new Error(
          `Connection timed out (${timeoutMs / 1000}s). Ensure backend is running and phone is connected.`
        );
      }
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check backend health status (/api/v1/health).
 */
export async function checkBackendHealth(): Promise<HealthResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/health`;

  try {
    const response = await fetchWithTimeout(url, undefined, 3000);
    if (!response.ok) {
      throw new Error(`Backend returned HTTP status ${response.status}`);
    }
    const data = await response.json();
    return {
      status: data.status || "ok",
      service: data.service || "saarthi-backend",
      version: data.version || "0.1.0",
    } as HealthResponse;
  } catch (error: any) {
    const fallbacks = CANDIDATE_BACKEND_URLS.filter((fb) => fb !== baseUrl);
    for (const fb of fallbacks) {
      try {
        const fbResp = await fetchWithTimeout(`${fb}/api/v1/health`, undefined, 2000);
        if (fbResp.ok) {
          setBackendBaseUrl(fb);
          const data = await fbResp.json();
          return {
            status: data.status || "ok",
            service: data.service || "saarthi-backend",
            version: data.version || "0.1.0",
          } as HealthResponse;
        }
      } catch {
        // Continue to next fallback
      }
    }
    throw new Error(
      error.message || "Failed to connect to SAARTHI backend server."
    );
  }
}

/**
 * Check whether Gemini AI is configured on the backend (/api/v1/ai/status).
 */
export async function checkAIStatus(): Promise<AIStatusResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/status`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`AI status check failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    return {
      configured: Boolean(data.configured ?? data.is_configured ?? data.gemini_ready),
      model: data.model || data.primary_model || "gemini-3.1-flash-lite",
      mock_mode: Boolean(data.mock_mode),
    };
  } catch (error: any) {
    throw new Error(
      error.message || "Failed to query AI configuration status."
    );
  }
}

/**
 * Send a connectivity test prompt through the backend to Gemini (/api/v1/ai/test).
 */
export async function testAIConnectivity(
  prompt: string = "Say hello in 5 words or less."
): Promise<AITestResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/test`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      },
      12000 // Allow up to 12s for LLM upstream response
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as AITestResponse;
  } catch (error: any) {
    throw new Error(error.message || "Failed to execute AI test request.");
  }
}

/**
 * Send a captured image to the backend for multimodal scene analysis (/api/v1/ai/vision).
 */
export async function analyzeSceneWithVision(
  imageBase64: string,
  prompt?: string,
  mimeType: string = "image/jpeg",
  signal?: AbortSignal
): Promise<AIVisionResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/vision`;

  const payload: {
    image_base64: string;
    prompt?: string;
    mime_type: string;
  } = {
    image_base64: imageBase64,
    mime_type: mimeType,
  };

  if (prompt && prompt.trim()) {
    payload.prompt = prompt.trim();
  }

  console.log(
    `[SAARTHI Vision Client] Sending request: b64_len=${imageBase64.length}, mimeType=${mimeType}, promptLen=${prompt?.length ?? 0}`
  );

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      30000, // Allow up to 30s for multimodal vision inference
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const result = data as AIVisionResponse;
    console.log(
      `[SAARTHI Vision Client] Response OK: model=${result.model}, descLen=${result.description.length}`
    );

    return result;
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.log("[SAARTHI Vision Client] Vision request aborted by user.");
      throw error;
    }
    throw new Error(error.message || "Failed to analyze image with Gemini Vision.");
  }
}

/**
 * Send extracted OCR text or image to the campus reading endpoint (/api/v1/campus/read).
 */
export async function readCampusText(
  params: {
    imageBase64?: string;
    ocrText?: string;
    readingMode?: "auto" | "timetable" | "sign" | "notice" | "surroundings";
  },
  signal?: AbortSignal
): Promise<CampusReadingResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/campus/read`;

  const payload = {
    image_base64: params.imageBase64,
    ocr_text: params.ocrText,
    reading_mode: params.readingMode || "auto",
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      25000,
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as CampusReadingResponse;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    throw new Error(error.message || "Failed to read campus text.");
  }
}

/**
 * Send a camera frame to the backend Live Scene Assist endpoint (/api/v1/ai/scene-assist).
 */
export async function analyzeSceneAssist(
  imageBase64: string,
  query?: string,
  mimeType: string = "image/jpeg",
  signal?: AbortSignal,
  targetObject?: string,
  previousDescription?: string
): Promise<SceneAnalysisResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/scene-assist`;

  const payload: {
    image_base64: string;
    query?: string;
    target_object?: string;
    previous_description?: string;
    mime_type: string;
  } = {
    image_base64: imageBase64,
    mime_type: mimeType,
  };

  if (query && query.trim()) {
    payload.query = query.trim();
  }
  if (targetObject && targetObject.trim()) {
    payload.target_object = targetObject.trim();
  }
  if (previousDescription && previousDescription.trim()) {
    payload.previous_description = previousDescription.trim();
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      20000,
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as SceneAnalysisResponse;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    throw new Error(error.message || "Failed to analyze scene with Gemma 4.");
  }
}

export interface LiveWsCallbacks {
  onSessionState?: (state: { status: string; sessionId?: string; model?: string }) => void;
  onDescription?: (description: {
    spokenDescription: string;
    confidence?: number;
    imageQuality?: string;
    seq?: number;
    uncertainties?: string[];
    uncheckedAreas?: string[];
  }) => void;
  onSearchResult?: (result: GroundedObjectSearchResult, seq?: number) => void;
  onError?: (err: { error: string; recoverable?: boolean; spokenDescription?: string }) => void;
  onClosed?: () => void;
}

export interface SceneLiveWebSocketSession {
  sendFrame: (base64Data: string, mimeType?: string, seq?: number) => void;
  sendQuery: (queryText: string, targetObject?: string, frameBase64?: string, mimeType?: string) => void;
  activate: (targetObject?: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  close: () => void;
  isConnected: () => boolean;
}

/**
 * Creates a server-managed WebSocket live session for low-latency scene understanding.
 */
export function createSceneLiveWebSocket(callbacks: LiveWsCallbacks): SceneLiveWebSocketSession {
  const baseUrl = getBackendBaseUrl();
  const wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/api/v1/ai/scene-live-ws";

  let socket: WebSocket | null = null;
  let isOpen = false;
  const outboundQueue: any[] = [];

  const sendJson = (data: any) => {
    if (socket && isOpen && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    } else {
      outboundQueue.push(data);
    }
  };

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      isOpen = true;
      console.log("[SceneLiveWS] Connected to", wsUrl);
      while (outboundQueue.length > 0) {
        const item = outboundQueue.shift();
        if (item && socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(item));
        }
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "session_state") {
          callbacks.onSessionState?.({
            status: msg.status || "active",
            sessionId: msg.session_id,
            model: msg.model,
          });
        } else if (msg.type === "description") {
          callbacks.onDescription?.({
            spokenDescription: msg.spoken_description,
            confidence: msg.confidence,
            imageQuality: msg.image_quality,
            seq: msg.seq,
            uncertainties: msg.uncertainties,
            uncheckedAreas: msg.unchecked_areas,
          });
        } else if (msg.type === "object_search_result") {
          if (msg.search_result) {
            callbacks.onSearchResult?.(msg.search_result, msg.seq);
          }
        } else if (msg.type === "error") {
          callbacks.onError?.({
            error: msg.error || "Vision service error",
            recoverable: msg.recoverable !== false,
            spokenDescription: msg.spoken_description,
          });
        } else if (msg.type === "session_terminated") {
          callbacks.onClosed?.();
        }
      } catch (err) {
        console.warn("[SceneLiveWS] Error parsing message:", err);
      }
    };

    socket.onerror = (err: any) => {
      console.warn("[SceneLiveWS] WebSocket error:", err?.message || err);
      callbacks.onError?.({
        error: "Live WebSocket connection error. Degrading to standard vision fallback.",
        recoverable: true,
      });
    };

    socket.onclose = () => {
      isOpen = false;
      callbacks.onClosed?.();
    };
  } catch (err) {
    console.warn("[SceneLiveWS] Socket initialization error:", err);
  }

  return {
    sendFrame: (base64Data: string, mimeType: string = "image/jpeg", seq: number = 0) => {
      sendJson({
        type: "frame",
        image_base64: base64Data,
        mime_type: mimeType,
        seq,
        timestamp: Date.now() / 1000,
      });
    },
    sendQuery: (queryText: string, targetObject?: string, frameBase64?: string, mimeType?: string) => {
      sendJson({
        type: "query",
        query: queryText,
        target_object: targetObject,
        image_base64: frameBase64,
        mime_type: mimeType || "image/jpeg",
        timestamp: Date.now() / 1000,
      });
    },
    activate: (targetObject?: string) => {
      sendJson({
        type: "activate",
        target_object: targetObject,
      });
    },
    pause: () => {
      sendJson({ type: "pause" });
    },
    resume: () => {
      sendJson({ type: "resume" });
    },
    stop: () => {
      sendJson({ type: "stop" });
    },
    close: () => {
      if (socket) {
        try {
          socket.close();
        } catch {
          // Safe ignore
        }
        socket = null;
        isOpen = false;
      }
    },
    isConnected: () => isOpen,
  };
}


