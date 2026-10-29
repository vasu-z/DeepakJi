import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  LiveAssistService,
  computeDescriptionSimilarity,
} from "./liveAssistService";

const mockSpeak = jest.fn((..._args: any[]) => Promise.resolve(true));
const mockStop = jest.fn((..._args: any[]) => Promise.resolve(true));
const mockIsSpeaking = jest.fn((..._args: any[]) => false);
const mockHaptic = jest.fn((..._args: any[]) => Promise.resolve());
const mockAnalyzeScene = jest.fn((..._args: any[]) => Promise.resolve({}));

jest.mock("./speech", () => ({
  speechService: {
    speak: (...args: any[]) => mockSpeak(...args),
    stop: (...args: any[]) => mockStop(...args),
    isSpeaking: (...args: any[]) => mockIsSpeaking(...args),
  },
}));

jest.mock("./haptics", () => ({
  hapticsService: {
    triggerButtonPress: (...args: any[]) => mockHaptic(...args),
  },
}));

jest.mock("../api/client", () => ({
  analyzeSceneAssist: (...args: any[]) => mockAnalyzeScene(...args),
}));

describe("LiveAssistService", () => {
  let service: LiveAssistService;

  beforeEach(() => {
    mockSpeak.mockClear();
    mockStop.mockClear();
    mockIsSpeaking.mockClear();
    mockHaptic.mockClear();
    mockAnalyzeScene.mockClear();
    service = new LiveAssistService();
  });

  afterEach(() => {
    service.cleanup();
  });

  describe("computeDescriptionSimilarity", () => {
    it("returns 1.0 for identical sentences", () => {
      const text = "In front of you is Room 204 Computer Science Department.";
      expect(computeDescriptionSimilarity(text, text)).toBe(1.0);
    });

    it("returns high similarity for minor stop-word variations", () => {
      const textA = "In front of you is a door to Room 204.";
      const textB = "Ahead of you is the door to Room 204.";
      const sim = computeDescriptionSimilarity(textA, textB);
      expect(sim).toBeGreaterThanOrEqual(0.70);
    });

    it("returns low similarity for different scenes", () => {
      const textA = "In front of you is a door to Room 204.";
      const textB = "A flight of stairs leads down to the library foyer.";
      const sim = computeDescriptionSimilarity(textA, textB);
      expect(sim).toBeLessThan(0.30);
    });
  });

  describe("Single Request in Flight Gate", () => {
    it("does not start a second analysis while one is already in flight", async () => {
      let resolveFirstCall: (value: any) => void = () => {};
      const firstCallPromise = new Promise((resolve) => {
        resolveFirstCall = resolve;
      });

      mockAnalyzeScene.mockReturnValue(firstCallPromise as any);

      service.registerFrameCapture(async () => ({
        base64: "fake_b64_data",
        mimeType: "image/jpeg",
      }));

      // Start first cycle
      const firstCyclePromise = service.describeNow();
      expect(service.getState().isAnalyzing).toBe(true);

      // Attempt second cycle while first is in flight
      const secondCycleResult = await service.describeNow();
      expect(secondCycleResult).toContain("already in progress");

      // Complete first cycle
      resolveFirstCall({
        status: "success",
        model: "Gemma 4",
        spoken_description: "Room 204 ahead.",
        objects: [],
        detected_texts: [],
        uncertainties: [],
        unchecked_areas: [],
        image_quality: "good",
        needs_rescan: false,
        confidence: 0.9,
      });

      await firstCyclePromise;
      expect(service.getState().isAnalyzing).toBe(false);
    });
  });

  describe("Duplicate Announcement Suppression", () => {
    it("suppresses identical speech within the cooldown window", async () => {
      mockAnalyzeScene.mockResolvedValue({
        status: "success",
        model: "Gemma 4",
        spoken_description: "In front of you is a wooden door to Room 204.",
        objects: [],
        detected_texts: [],
        uncertainties: [],
        unchecked_areas: [],
        image_quality: "good",
        needs_rescan: false,
        confidence: 0.9,
      } as any);

      service.registerFrameCapture(async () => ({
        base64: "fake_b64",
        mimeType: "image/jpeg",
      }));

      // First run (not forced duplicate check)
      await service["executeAnalysisCycle"](undefined, false);
      expect(mockSpeak).toHaveBeenCalledTimes(1);

      // Second identical run: should be suppressed
      await service["executeAnalysisCycle"](undefined, false);
      expect(mockSpeak).toHaveBeenCalledTimes(1); // Not called again!
      expect(service.getState().suppressedCount).toBe(1);

      // But a user-forced request ("Describe Now") should speak even if duplicate
      await service.describeNow();
      expect(mockSpeak).toHaveBeenCalledTimes(2);
    });
  });

  describe("Immediate Stop and Cancellation", () => {
    it("aborts active in-flight request and stops speech", async () => {
      service.registerFrameCapture(async () => ({
        base64: "fake_b64",
        mimeType: "image/jpeg",
      }));

      mockAnalyzeScene.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)) as any
      );

      service.describeNow();
      expect(service.getState().isAnalyzing).toBe(true);

      // Call stop
      await service.stop();

      expect(mockStop).toHaveBeenCalled();
      expect(service.getState().isSamplingActive).toBe(false);
      expect(service.getState().isAnalyzing).toBe(false);
    });
  });

  describe("Honest Error and Safety Handling", () => {
    it("speaks guidance for blurry/poor quality images without guessing", async () => {
      mockAnalyzeScene.mockResolvedValue({
        status: "low_quality",
        model: "Gemma 4",
        spoken_description: "Image is blurry.",
        objects: [],
        detected_texts: [],
        uncertainties: [],
        unchecked_areas: [],
        image_quality: "poor",
        needs_rescan: true,
        confidence: 0.4,
      } as any);

      service.registerFrameCapture(async () => ({
        base64: "fake_b64",
        mimeType: "image/jpeg",
      }));

      const desc = await service.describeNow();
      expect(desc).toContain("blurry or dark");
      expect(mockSpeak).toHaveBeenCalledWith(
        expect.stringContaining("blurry or dark"),
        expect.any(Object)
      );
    });

    it("handles network failure honestly without crash", async () => {
      mockAnalyzeScene.mockRejectedValue(
        new Error("Network connection lost.") as any
      );

      service.registerFrameCapture(async () => ({
        base64: "fake_b64",
        mimeType: "image/jpeg",
      }));

      const result = await service.describeNow();
      expect(result).toContain("Network connection lost");
      expect(service.getState().error).toContain("Network connection lost");
    });
  });

  describe("Feature 01: Lifecycle & Spoken Announcements", () => {
    it("speaks exact greeting on activation and transitions to active", async () => {
      service.registerFrameCapture(async () => ({
        base64: "test_frame",
        mimeType: "image/jpeg",
      }));

      await service.startLiveAssist();

      expect(mockSpeak).toHaveBeenCalledWith(
        "Saarthi scene understanding is on. Point your camera around; ask me anything.",
        expect.objectContaining({ force: true })
      );
      expect(service.getState().status).toBe("active");
      expect(service.getState().isSamplingActive).toBe(true);
    });

    it("speaks exact stop message and cleans up on stop", async () => {
      service.registerFrameCapture(async () => ({
        base64: "test_frame",
        mimeType: "image/jpeg",
      }));

      await service.startLiveAssist();
      mockSpeak.mockClear();

      await service.stop();

      expect(mockSpeak).toHaveBeenCalledWith(
        "Scene understanding stopped.",
        expect.objectContaining({ force: true })
      );
      expect(service.getState().status).toBe("idle");
      expect(service.getState().isSamplingActive).toBe(false);
    });

    it("supports pause and resume with clear audible feedback", async () => {
      service.registerFrameCapture(async () => ({
        base64: "test_frame",
        mimeType: "image/jpeg",
      }));

      await service.startLiveAssist();
      mockSpeak.mockClear();

      // Pause
      await service.pauseLiveAssist();
      expect(service.getState().status).toBe("paused");
      expect(service.getState().isSamplingActive).toBe(false);
      expect(mockSpeak).toHaveBeenCalledWith(
        expect.stringContaining("Scene understanding paused"),
        expect.objectContaining({ force: true })
      );

      mockSpeak.mockClear();

      // Resume
      await service.resumeLiveAssist();
      expect(service.getState().status).toBe("active");
      expect(service.getState().isSamplingActive).toBe(true);
      expect(mockSpeak).toHaveBeenCalledWith(
        "Scene understanding resumed.",
        expect.objectContaining({ force: true })
      );
    });
  });

  describe("Feature 01: Grounded Object Search ('Where are my keys?')", () => {
    it("reports grounded relative position when object is found", async () => {
      service.registerFrameCapture(async () => ({
        base64: "frame_with_keys",
        mimeType: "image/jpeg",
      }));

      mockAnalyzeScene.mockResolvedValueOnce({
        status: "success",
        model: "Gemma 4",
        spoken_description: "I found your keys near the lower-left side of the table.",
        objects: [
          {
            name: "keys",
            confidence: 0.94,
            relative_position: "lower-left",
            bounding_box: [0.65, 0.15, 0.8, 0.35],
          },
        ],
        detected_texts: [],
        uncertainties: [],
        unchecked_areas: ["floor beneath table"],
        image_quality: "good",
        needs_rescan: false,
        confidence: 0.94,
        search_result: {
          is_found: true,
          target_object: "keys",
          relative_frame_position: "lower-left",
          confidence: 0.94,
          spoken_description: "I found your keys near the lower-left side of the table.",
          sweep_guidance: null,
          next_action: "reached",
        },
      } as any);

      const result = await service.searchTargetObject("keys");

      expect(result).toContain("lower-left");
      expect(mockSpeak).toHaveBeenCalledWith(
        expect.stringContaining("lower-left"),
        expect.objectContaining({ force: true })
      );
      expect(service.getState().lastSearchResult?.is_found).toBe(true);
      expect(service.getState().lastSearchResult?.relative_frame_position).toBe("lower-left");
    });

    it("speaks sweep guidance when object is not yet visible", async () => {
      service.registerFrameCapture(async () => ({
        base64: "frame_without_keys",
        mimeType: "image/jpeg",
      }));

      mockAnalyzeScene.mockResolvedValueOnce({
        status: "success",
        model: "Gemma 4",
        spoken_description: "I can't see the keys clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking.",
        objects: [],
        detected_texts: [],
        uncertainties: ["keys not in field of view"],
        unchecked_areas: ["left and right periphery"],
        image_quality: "good",
        needs_rescan: false,
        confidence: 0.88,
        search_result: {
          is_found: false,
          target_object: "keys",
          relative_frame_position: null,
          confidence: 0.88,
          spoken_description: "I can't see the keys clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking.",
          sweep_guidance: "Slowly sweep the camera across the nearby surfaces and I'll keep checking.",
          next_action: "sweep_camera",
        },
      } as any);

      const result = await service.searchTargetObject("keys");

      expect(result).toContain("Slowly sweep");
      expect(mockSpeak).toHaveBeenCalledWith(
        expect.stringContaining("Slowly sweep"),
        expect.objectContaining({ force: true })
      );
      expect(service.getState().isSearching).toBe(true);
    });

    it("stops searching and speaks conclusion after sweep limit is reached", async () => {
      service.registerFrameCapture(async () => ({
        base64: "frame_without_keys",
        mimeType: "image/jpeg",
      }));

      mockAnalyzeScene.mockResolvedValue({
        status: "success",
        model: "Gemma 4",
        spoken_description: "No keys visible yet.",
        objects: [],
        detected_texts: [],
        uncertainties: [],
        unchecked_areas: [],
        image_quality: "good",
        needs_rescan: false,
        confidence: 0.85,
        search_result: {
          is_found: false,
          target_object: "keys",
          relative_frame_position: null,
          confidence: 0.85,
          spoken_description: "No keys visible yet.",
          sweep_guidance: "Slowly sweep the camera.",
          next_action: "sweep_camera",
        },
      } as any);

      // Perform sweeps up to MAX_SWEEP_ATTEMPTS (5)
      let finalResult = "";
      for (let i = 0; i < 5; i++) {
        finalResult = await service.searchTargetObject("keys");
      }

      expect(finalResult).toContain("still can't see the keys");
      expect(service.getState().isSearching).toBe(false);
      expect(service.getState().activeTargetObject).toBeNull();
    });
  });
});

