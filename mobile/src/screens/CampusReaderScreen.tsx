import React, { useState, useRef, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, PermissionResponse } from "expo-camera";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { readingPipeline, ReadingPipelineResult } from "../services/readingPipeline";
import { analyzeSceneWithVision, CampusReadingResponse } from "../api/client";
import { globalVoiceService } from "../services/globalVoiceService";
import { voiceRecognitionService } from "../services/voiceRecognition";

import {
  CameraPermissionState,
  resolveCameraPermissionState,
} from "../utils/cameraPermissions";

export type { CameraPermissionState };
export { resolveCameraPermissionState };

export type ReadingMode = "auto" | "timetable" | "sign" | "notice" | "surroundings";

export interface CampusReaderScreenProps {
  initialMode?: ReadingMode;
  onNavigateBack: () => void;
  onReadingComplete: (result: ReadingPipelineResult, mode: ReadingMode, imageUri?: string) => void;
  permissionResponse?: PermissionResponse | null;
  onRequestPermission?: () => Promise<PermissionResponse>;
  onRegisterScanTrigger?: (trigger: (() => Promise<void>) | null) => void;
  onOpenLiveAssist?: () => void;
}

// Geometric layout tokens matching approved 3-section reference design
const SCREEN_PADDING = 16;
const GRID_GAP = 14;
const SURROUNDINGS_DIAMETER = 140;
const SURROUNDINGS_RADIUS = SURROUNDINGS_DIAMETER / 2; // 70dp
const OUTER_CORNER_RADIUS = 28;

const CORNER_PANEL_STYLES = {
  topLeft: {
    backgroundColor: "#005CE6",
    borderColor: "#38BDF8",
    borderWidth: 1.5,
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: 64,
  },
  topRight: {
    backgroundColor: "#00A84D",
    borderColor: "#4ADE80",
    borderWidth: 1.5,
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: 64,
  },
  bottomLeft: {
    backgroundColor: "#FF5500",
    borderColor: "#FB923C",
    borderWidth: 1.5,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: 64,
  },
  bottomRight: {
    backgroundColor: "#7525E6",
    borderColor: "#C084FC",
    borderWidth: 1.5,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderTopLeftRadius: 64,
  },
} as const;

export const CampusReaderScreen: React.FC<CampusReaderScreenProps> = ({
  initialMode = "auto",
  onNavigateBack,
  onReadingComplete,
  permissionResponse: propPermission,
  onRequestPermission: propRequestPermission,
  onRegisterScanTrigger,
  onOpenLiveAssist,
}) => {
  const insets = useSafeAreaInsets();

  const cameraRef = useRef<CameraView>(null);
  const [hookPermission, hookRequestPermission] = useCameraPermissions();
  const permission = propPermission !== undefined ? propPermission : hookPermission;
  const requestPermission = propRequestPermission || hookRequestPermission;
  const [readingMode, setReadingMode] = useState<ReadingMode>(initialMode);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [processingStage, setProcessingStage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);

  const isCapturingRef = useRef<boolean>(false);
  const readingModeRef = useRef<ReadingMode>(readingMode);
  readingModeRef.current = readingMode;
  const hasAnnouncedStartupRef = useRef<boolean>(false);

  // 1. Voice-guided startup on mount
  useEffect(() => {
    if (hasAnnouncedStartupRef.current) return;
    hasAnnouncedStartupRef.current = true;

    (async () => {
      const voiceState = globalVoiceService.getState();
      const avail = voiceRecognitionService.checkAvailability();

      // If speech recognition is not supported on this platform/device
      if (!avail.available) {
        const recoveryMsg =
          "Auto Read active. Point your camera steady at text or a sign about 1 to 2 feet away. Voice recognition is unavailable. Tap anywhere on the screen to take a scan.";
        await speechService.speak(recoveryMsg, { force: true });
        return;
      }

      // If voice mode is already active and paused, DO NOT unpause!
      if (voiceState.isActive && voiceState.isPaused) {
        const pausedMsg =
          "Auto Read active. Point your camera steady about 1 to 2 feet away. Voice listening is paused. Tap the voice button to resume listening, or tap the screen to take a scan.";
        await speechService.speak(pausedMsg, { force: true });
        return;
      }

      // If voice mode is active and listening
      if (voiceState.isActive && !voiceState.isPaused) {
        const guideMsg =
          "Auto Read active. Point your camera steady at a document or sign about 1 to 2 feet away. Say 'scan now' or tap the screen to capture.";
        await speechService.speak(guideMsg, { force: true });
        return;
      }

      // Voice mode is not active: verify permissions and activate
      const micGranted = await voiceRecognitionService.requestPermissions();
      if (!micGranted) {
        const micDeniedMsg =
          "Auto Read active. Microphone permission was denied. Tap anywhere on the screen to scan, or allow microphone access in Settings to use voice commands.";
        await speechService.speak(micDeniedMsg, { force: true });
        return;
      }

      await globalVoiceService.enableVoiceMode(
        "Auto Read active. Point your camera steady at a document or sign about 1 to 2 feet away. Say 'scan now' or tap the screen to capture."
      );
    })();
  }, []);

  // 2. Register real scan trigger for voice dispatcher
  useEffect(() => {
    if (onRegisterScanTrigger) {
      onRegisterScanTrigger(async () => {
        await executeCapture(readingModeRef.current);
      });
    }
    return () => {
      onRegisterScanTrigger?.(null);
    };
  }, [onRegisterScanTrigger]);

  // Layout sizing: calculate responsive section dimensions
  const topInset = Math.max(insets.top, 12);
  const bottomInset = Math.max(insets.bottom, 12);

  const modeDescriptions: Record<ReadingMode, { title: string; subtitle: string; desc: string }> = {
    auto: {
      title: "Auto Read",
      subtitle: "General Text",
      desc: "Auto Read mode: Reads printed documents, signs, and textbook pages.",
    },
    sign: {
      title: "Door Sign",
      subtitle: "Room & Labels",
      desc: "Door Sign mode: Reads classroom door plaques, department names, and room numbers.",
    },
    timetable: {
      title: "Timetable",
      subtitle: "Class Schedule",
      desc: "Timetable mode: Extracts course codes, class timings, and lecture halls.",
    },
    notice: {
      title: "Notice",
      subtitle: "Posters & Info",
      desc: "Notice mode: Summarizes campus bulletin boards, deadlines, and event posters.",
    },
    surroundings: {
      title: "Surroundings",
      subtitle: "Describe what's around you",
      desc: "Surroundings mode: Multimodal vision scene analysis for navigation and obstacles.",
    },
  };

  // Replay spoken screen instructions
  const handleAnnounceInstructions = async () => {
    await hapticsService.triggerButtonPress();
    const instructions =
      "Campus Reader. Say 'scan now' or tap to scan. Tap any corner to change mode: Auto Read for general text, Door Sign for room plaques, Timetable for class schedules, or Notice for posters. Or tap Surroundings in the center to describe what is visibly around you.";
    await speechService.speak(instructions, { force: true });
  };

  // Safe navigation back
  const handleBack = async () => {
    await hapticsService.triggerBottomLeft();
    await speechService.stop();
    onNavigateBack();
  };

  // Capture pipeline for the reading modes with duplicate prevention
  const executeCapture = async (mode: ReadingMode = readingMode) => {
    if (isCapturingRef.current || isCapturing) {
      console.log("[CampusReaderScreen] executeCapture skipped: already capturing");
      return;
    }

    if (!permission?.granted) {
      await speechService.speak("Camera permission is required to take a scan.", { force: true });
      return;
    }

    if (!cameraRef.current) {
      await speechService.speak("Camera is initializing, please wait a moment.", { force: true });
      return;
    }

    try {
      isCapturingRef.current = true;
      setIsCapturing(true);
      setErrorMessage(null);
      setProcessingStage("Capturing photo...");
      await hapticsService.triggerCapture();

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.85,
        skipProcessing: false,
      });

      if (!photo || !photo.uri) {
        throw new Error("Camera did not return a valid photo.");
      }

      const modeInfo = modeDescriptions[mode] || modeDescriptions.auto;
      setProcessingStage(`Analyzing with Gemma 4 (${modeInfo.title})...`);
      await speechService.speak(`Image captured. Reading ${modeInfo.title}...`, { force: true });

      const result = await readingPipeline.processCampusImage({
        imageUri: photo.uri,
        imageBase64: photo.base64,
        readingMode: mode,
      });

      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      onReadingComplete(result, mode, photo.uri);
    } catch (err: any) {
      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      const msg =
        err?.message ||
        "I couldn't read that clearly. Please hold steady, ensure good lighting, and say 'scan now' or tap to scan again.";
      setErrorMessage(msg);
      await speechService.speak(msg, { force: true });
    }
  };

  // Capture & Multimodal Vision Pipeline for Surroundings
  const executeSurroundingsVision = async () => {
    if (isCapturing) return;

    if (!permission?.granted) {
      await speechService.speak("Camera permission is required for surroundings analysis.", {
        force: true,
      });
      return;
    }

    if (!cameraRef.current) {
      await speechService.speak("Camera is initializing, please wait a moment.", { force: true });
      return;
    }

    try {
      setIsCapturing(true);
      setErrorMessage(null);
      setProcessingStage("Capturing photo...");
      await hapticsService.triggerCapture();
      await speechService.speak("Analyzing surroundings with Gemma 4 vision...", { force: true });

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.85,
        skipProcessing: false,
      });

      if (!photo || !photo.uri || !photo.base64) {
        throw new Error("Camera did not return image data for vision analysis.");
      }

      setProcessingStage("Describing scene with Gemma 4 vision...");
      const visionResult = await analyzeSceneWithVision(
        photo.base64,
        "Describe what is visibly in front of and around the student on this university campus, including room doors, signs, corridors, stairs, and obstacles."
      );

      const campusResponse: CampusReadingResponse = {
        status: visionResult.status,
        reading_mode: "auto",
        spoken_summary: visionResult.description,
        confidence: visionResult.confidence ?? 0.9,
        needs_rescan: Boolean(visionResult.needs_rescan),
        source_text: visionResult.extracted_text || visionResult.description,
        timetable_items: [],
        notices: [],
        uncertainties: visionResult.uncertainties || [],
        unchecked_areas: visionResult.unchecked_areas || [],
      };

      const pipelineResult: ReadingPipelineResult = {
        spokenText: visionResult.description,
        response: campusResponse,
      };

      await speechService.speak(visionResult.description, { force: true });
      setIsCapturing(false);
      setProcessingStage("");
      onReadingComplete(pipelineResult, "auto", photo.uri);
    } catch (err: any) {
      setIsCapturing(false);
      setProcessingStage("");
      const msg =
        err?.message ||
        "I could not analyze your surroundings right now. Please check your network connection and try again.";
      setErrorMessage(msg);
      await speechService.speak(msg, { force: true });
    }
  };

  // Corner Tap Handler: Arm mode on first tap; trigger capture if already armed
  const handleCornerPress = async (mode: ReadingMode) => {
    if (readingMode === mode) {
      // Already armed: execute capture
      await executeCapture(mode);
    } else {
      // Arm new mode with distinct haptic pattern per corner
      switch (mode) {
        case "auto":
          await hapticsService.triggerTopLeft();
          break;
        case "sign":
          await hapticsService.triggerTopRight();
          break;
        case "timetable":
          await hapticsService.triggerBottomLeft();
          break;
        case "notice":
          await hapticsService.triggerBottomRight();
          break;
      }
      setReadingMode(mode);
      const desc = modeDescriptions[mode];
      await speechService.speak(
        `${desc.title} armed for ${desc.subtitle}. Tap again to capture photo.`,
        { force: true }
      );
    }
  };

  // Permission handling: Distinguish between loading, denied, and granted states
  const permissionState = resolveCameraPermissionState(permission);

  // 1. Permission is still loading or unknown: show neutral dark loading indicator
  // Never display "Camera Access Required" while permission is still being retrieved
  if (permissionState === "loading") {
    return (
      <View
        style={[
          styles.loadingContainer,
          {
            paddingTop: topInset,
            paddingBottom: bottomInset,
          },
        ]}
        accessible={true}
        accessibilityRole="progressbar"
        accessibilityLabel="Initializing camera"
      >
        <ActivityIndicator size="large" color="#38BDF8" />
        <Text style={styles.loadingStateText}>Initializing camera...</Text>
      </View>
    );
  }

  // 2. Permission confirmed denied / not granted: show explicit request UI
  if (permissionState === "denied") {
    return (
      <View
        style={[
          styles.permissionContainer,
          {
            paddingTop: Math.max(insets.top, 24),
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        <Ionicons name="camera-outline" size={72} color={Colors.primary} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionDescription}>
          SAARTHI uses your camera in real time to read university door signs, schedule timetables,
          and campus bulletin boards.
        </Text>
        <Pressable
          onPress={requestPermission}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
          style={styles.permissionButton}
        >
          <Text style={styles.permissionButtonText}>Allow Camera Access</Text>
        </Pressable>
        <Pressable
          onPress={handleBack}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Go back to Home"
          style={styles.permissionCancelButton}
        >
          <Text style={styles.permissionCancelButtonText}>Cancel & Return to Home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* 1. Live Camera View Hardware Mounted in Background for Instant Capture */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="picture"
        onCameraReady={() => setIsCameraReady(true)}
      />

      {/* 2. Solid Near-Black High-Contrast UI Overlay */}
      <View
        style={[
          styles.screenOverlay,
          {
            paddingTop: topInset,
            paddingBottom: bottomInset,
          },
        ]}
        accessible={false}
      >

        {/* Error Recovery Card (if scan failed) */}
        {errorMessage && (
          <View style={styles.errorOverlayCard} accessible={true} accessibilityRole="alert">
            <View style={styles.errorHeaderRow}>
              <Ionicons name="alert-circle" size={22} color={Colors.error} />
              <Text style={styles.errorTitle}>Scan Incomplete</Text>
            </View>
            <Text style={styles.errorBody}>{errorMessage}</Text>
            <View style={styles.errorButtonsRow}>
              <Pressable
                onPress={() => setErrorMessage(null)}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Dismiss error and try scanning again"
                style={styles.errorDismissButton}
              >
                <Text style={styles.errorDismissButtonText}>Dismiss</Text>
              </Pressable>
              <Pressable
                onPress={() => executeCapture(readingMode)}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Retry capture now"
                style={styles.errorRetryButton}
              >
                <Text style={styles.errorRetryButtonText}>Retry Capture</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Processing State Overlay */}
        {isCapturing && (
          <View style={styles.loadingOverlay} accessible={true} accessibilityRole="progressbar">
            <View style={styles.loadingCard}>
              <ActivityIndicator size="large" color="#38BDF8" />
              <Text style={styles.loadingTitle}>Reading Campus View</Text>
              <Text style={styles.loadingSubtitle}>{processingStage}</Text>
            </View>
          </View>
        )}

        {/* Main Content Area Divided into 3 Distinct Vertical Sections */}
        <View style={styles.mainContentContainer}>
          {/* TOP SECTION: Two Equal-Sized Panels Side by Side */}
          <View style={styles.tilesRow}>
            {/* Top-Left: AUTO READ (Blue) */}
            <View style={styles.tileOuterWrapper}>
              <Pressable
                onPress={() => handleCornerPress("auto")}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel={
                  readingMode === "auto"
                    ? "Auto Read, General Text. Armed. Double-tap to take photo and scan."
                    : "Auto Read, General Text. Double-tap to arm Auto Read mode, then tap again to capture."
                }
                accessibilityHint="Reads books, handouts, and standard documents"
                style={({ pressed }) => [
                  styles.tilePressable,
                  CORNER_PANEL_STYLES.topLeft,
                  pressed && styles.tilePressed,
                ]}
              >
                <View style={styles.tileContent}>
                  <Ionicons name="scan" size={44} color="#FFFFFF" style={styles.tileIcon} />
                  <Text style={styles.tileTitle}>AUTO READ</Text>
                  <Text style={styles.tileSubtitle}>General Text</Text>
                </View>
              </Pressable>
            </View>

            {/* Top-Right: DOOR SIGN (Green) */}
            <View style={styles.tileOuterWrapper}>
              <Pressable
                onPress={() => handleCornerPress("sign")}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel={
                  readingMode === "sign"
                    ? "Door Sign, Room and Labels. Armed. Double-tap to take photo and scan."
                    : "Door Sign, Room and Labels. Double-tap to arm Door Sign mode, then tap again to capture."
                }
                accessibilityHint="Reads classroom plaques, office names, and room numbers"
                style={({ pressed }) => [
                  styles.tilePressable,
                  CORNER_PANEL_STYLES.topRight,
                  pressed && styles.tilePressed,
                ]}
              >
                <View style={styles.tileContent}>
                  <MaterialCommunityIcons
                    name="door-open"
                    size={46}
                    color="#FFFFFF"
                    style={styles.tileIcon}
                  />
                  <Text style={styles.tileTitle}>DOOR SIGN</Text>
                  <Text style={styles.tileSubtitle}>Room & Labels</Text>
                </View>
              </Pressable>
            </View>
          </View>

          {/* ==================== 2. MIDDLE SECTION (CRITICAL) ==================== */}
          {/* Dedicated Horizontal Control Row with Back (Left), Surroundings (Center), Speaker (Right) */}
          <View style={styles.middleControlRow}>
            {/* 1. Back Button on the Left */}
            <View style={styles.sideControlWrapper}>
              <Pressable
                onPress={handleBack}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Back to Home Screen"
                accessibilityHint="Double-tap to return to the home screen"
                style={({ pressed }) => [
                  styles.sideCircleButton,
                  pressed && styles.sideCirclePressed,
                ]}
                hitSlop={8}
              >
                <Ionicons name="arrow-back" size={28} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.sideControlLabel}>Back</Text>
            </View>

            {/* 2. Prominent Circular Surroundings Button in the Center */}
            <View style={styles.surroundingsWrapper}>
              <Pressable
                onPress={() => {
                  if (onOpenLiveAssist) {
                    onOpenLiveAssist();
                  } else {
                    executeSurroundingsVision();
                  }
                }}
                disabled={isCapturing}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Live Camera Assist and Surroundings. Describe what is visibly around you. Double-tap to activate."
                accessibilityHint="Opens Live Camera Assist with real-time camera preview, scene analysis, and obstacle awareness"
                style={({ pressed }) => [
                  styles.surroundingsCircleButton,
                  pressed && styles.surroundingsCirclePressed,
                ]}
              >
                <Ionicons name="camera" size={38} color="#FFFFFF" style={styles.centerCameraIcon} />
                <Text style={styles.surroundingsTitle}>SURROUNDINGS</Text>
                <Text style={styles.surroundingsSubtitle}>Describe what's{"\n"}around you</Text>
              </Pressable>
            </View>

            {/* 3. Speaker Button on the Right */}
            <View style={styles.sideControlWrapper}>
              <Pressable
                onPress={handleAnnounceInstructions}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Hear screen instructions"
                accessibilityHint="Double-tap to listen to audio guidance for using the campus reader"
                style={({ pressed }) => [
                  styles.sideCircleButton,
                  pressed && styles.sideCirclePressed,
                ]}
                hitSlop={8}
              >
                <Ionicons name="volume-high" size={28} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.sideControlLabel}>Speaker</Text>
            </View>
          </View>

          {/* ==================== 3. BOTTOM SECTION ==================== */}
          {/* Below Middle Control Row: Two Equal-Sized Panels Side by Side */}
          <View style={styles.tilesRow}>
            {/* Bottom-Left: TIMETABLE (Orange) */}
            <View style={styles.tileOuterWrapper}>
              <Pressable
                onPress={() => handleCornerPress("timetable")}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel={
                  readingMode === "timetable"
                    ? "Timetable, Class Schedule. Armed. Double-tap to take photo and scan."
                    : "Timetable, Class Schedule. Double-tap to arm Timetable mode, then tap again to capture."
                }
                accessibilityHint="Extracts course schedules, lecture times, and room assignments"
                style={({ pressed }) => [
                  styles.tilePressable,
                  CORNER_PANEL_STYLES.bottomLeft,
                  pressed && styles.tilePressed,
                ]}
              >
                <View style={styles.tileContent}>
                  <Ionicons name="calendar" size={44} color="#FFFFFF" style={styles.tileIcon} />
                  <Text style={styles.tileTitle}>TIMETABLE</Text>
                  <Text style={styles.tileSubtitle}>Class Schedule</Text>
                </View>
              </Pressable>
            </View>

            {/* Bottom-Right: NOTICE (Purple) */}
            <View style={styles.tileOuterWrapper}>
              <Pressable
                onPress={() => handleCornerPress("notice")}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel={
                  readingMode === "notice"
                    ? "Notice, Posters and Info. Armed. Double-tap to take photo and scan."
                    : "Notice, Posters and Info. Double-tap to arm Notice mode, then tap again to capture."
                }
                accessibilityHint="Summarizes campus bulletins, announcements, and deadlines"
                style={({ pressed }) => [
                  styles.tilePressable,
                  CORNER_PANEL_STYLES.bottomRight,
                  pressed && styles.tilePressed,
                ]}
              >
                <View style={styles.tileContent}>
                  <Ionicons name="document-text" size={44} color="#FFFFFF" style={styles.tileIcon} />
                  <Text style={styles.tileTitle}>NOTICE</Text>
                  <Text style={styles.tileSubtitle}>Posters & Info</Text>
                </View>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#030712",
  },
  screenOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#030712", // Pure, uniform near-black background
    paddingHorizontal: SCREEN_PADDING,
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: Colors.background,
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionTitle: {
    fontSize: 24,
    fontWeight: "900",
    color: Colors.textPrimary,
    marginTop: 20,
    marginBottom: 12,
    textAlign: "center",
  },
  permissionDescription: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  permissionButton: {
    width: "100%",
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    minHeight: 56,
    justifyContent: "center",
    marginBottom: 12,
  },
  permissionButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  permissionCancelButton: {
    width: "100%",
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    minHeight: 52,
    justifyContent: "center",
  },
  permissionCancelButtonText: {
    color: Colors.textPrimary,
    fontSize: 15,
    fontWeight: "700",
  },


  // Main Content Container: divides vertical space cleanly among Top, Middle, and Bottom
  mainContentContainer: {
    flex: 1,
    justifyContent: "space-between",
  },

  // 2-Column Tile Rows (Top Section & Bottom Section)
  tilesRow: {
    flex: 1,
    flexDirection: "row",
    gap: GRID_GAP,
  },
  tileOuterWrapper: {
    flex: 1,
    height: "100%",
  },
  tilePressable: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  tilePressed: {
    opacity: 0.88,
    transform: [{ scale: 0.98 }],
  },
  tileContent: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  tileIcon: {
    marginBottom: 10,
  },
  tileTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  tileSubtitle: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 4,
  },

  // ==================== 2. MIDDLE CONTROL ROW ====================
  // Dedicated horizontal row aligning Back (Left), Surroundings (Center), and Speaker (Right)
  middleControlRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    marginVertical: 0,
    height: 118,
  },
  sideControlWrapper: {
    alignItems: "center",
    justifyContent: "center",
    width: 76,
  },
  sideCircleButton: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: "#131D33",
    borderWidth: 1.5,
    borderColor: "#2A3854",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  sideCirclePressed: {
    opacity: 0.8,
    transform: [{ scale: 0.94 }],
  },
  sideControlLabel: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6,
    textAlign: "center",
  },
  surroundingsWrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  surroundingsCircleButton: {
    width: SURROUNDINGS_DIAMETER,
    height: SURROUNDINGS_DIAMETER,
    borderRadius: SURROUNDINGS_DIAMETER / 2,
    backgroundColor: "#1F0E42",
    borderWidth: 2,
    borderColor: "#C084FC",
    alignItems: "center",
    justifyContent: "center",
    padding: 10,
    shadowColor: "#A855F7",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.65,
    shadowRadius: 14,
    elevation: 8,
  },
  surroundingsCirclePressed: {
    opacity: 0.88,
    transform: [{ scale: 0.96 }],
  },
  centerCameraIcon: {
    marginBottom: 4,
  },
  surroundingsTitle: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.5,
    textAlign: "center",
  },
  surroundingsSubtitle: {
    color: "#CBD5E1",
    fontSize: 10,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 13,
    marginTop: 2,
  },

  // Overlays
  errorOverlayCard: {
    backgroundColor: "#1E1218",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.error,
    padding: 14,
    marginBottom: 10,
  },
  errorHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  errorTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
  },
  errorBody: {
    color: "#E2E8F0",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  errorButtonsRow: {
    flexDirection: "row",
    gap: 10,
  },
  errorDismissButton: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  errorDismissButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  errorRetryButton: {
    flex: 1,
    backgroundColor: "#05DF72",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  errorRetryButtonText: {
    color: "#030712",
    fontSize: 13,
    fontWeight: "800",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(3, 7, 18, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 25,
  },
  loadingCard: {
    backgroundColor: "#0F172A",
    borderRadius: 18,
    padding: 24,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#38BDF8",
    width: "80%",
    maxWidth: 320,
  },
  loadingTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 14,
    textAlign: "center",
  },
  loadingSubtitle: {
    color: "#94A3B8",
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: "#030712",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loadingStateText: {
    color: "#94A3B8",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 14,
    textAlign: "center",
  },
});
