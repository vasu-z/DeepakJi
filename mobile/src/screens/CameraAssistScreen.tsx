/**
 * Saarthi Camera Assist Screen — Live Scene Understanding for Blind/Low-Vision Users.
 *
 * Implements:
 * 1. Strict Four-Corner Tactile Interaction Model:
 *    - Top-Left: Describe Now (Tap) / What Changed? (Long Press) (Accessible Blue, Haptic Light)
 *    - Top-Right: Pause / Resume Live Streaming (Accessible Emerald, Haptic Medium)
 *    - Bottom-Left: Stop Speech & Stream (Tap) / Exit Back (Long Press) (Accessible Red, Haptic Selection)
 *    - Bottom-Right: Where are my keys? (Tap) / Voice Question (Long Press) (Accessible Purple, Haptic Heavy)
 * 2. 78dp touch targets with 12dp hitSlop exceeding WCAG AAA standards.
 * 3. High-contrast HUD with honest visual indicators for sighted helpers.
 * 4. Grounded relative frame positions only (never invented physical distances).
 * 5. Instant barge-in / interruption when user speaks or taps Stop.
 * 6. Clean lifecycle management: camera starts only after explicit activation; full release on unmount.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  AccessibilityInfo,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, PermissionResponse } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { liveAssistService, LiveAssistState } from "../services/liveAssistService";
import { resolveCameraPermissionState } from "../utils/cameraPermissions";
import { globalVoiceService } from "../services/globalVoiceService";

export interface CameraAssistScreenProps {
  onNavigateBack: () => void;
  permissionResponse?: PermissionResponse | null;
  onRequestPermission?: () => Promise<PermissionResponse>;
  initialAutoStart?: boolean;
}

export const CameraAssistScreen: React.FC<CameraAssistScreenProps> = ({
  onNavigateBack,
  permissionResponse: propPermission,
  onRequestPermission: propRequestPermission,
  initialAutoStart = true,
}) => {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);

  const [hookPermission, hookRequestPermission] = useCameraPermissions();
  const permission = propPermission !== undefined ? propPermission : hookPermission;
  const requestPermission = propRequestPermission || hookRequestPermission;

  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);
  const [assistState, setAssistState] = useState<LiveAssistState>(
    liveAssistService.getState()
  );

  // Subscribe to live assist service state
  useEffect(() => {
    const unsubscribe = liveAssistService.subscribe((state) => {
      setAssistState(state);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const isTakingPictureRef = useRef<boolean>(false);

  // Frame capture implementation using real installed camera with retry & concurrency lock
  const captureFrame = useCallback(async () => {
    if (isTakingPictureRef.current) {
      console.log("[CameraAssistScreen] Frame capture skipped: picture already in progress.");
      return null;
    }

    // Wait up to 1500ms for camera to be ready if it's still initializing
    let attempts = 0;
    while (!cameraRef.current && attempts < 15) {
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    if (!cameraRef.current) {
      console.warn("[CameraAssistScreen] Camera ref not available for capture.");
      return null;
    }

    try {
      isTakingPictureRef.current = true;
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.45,
        skipProcessing: false,
      });

      if (!photo || !photo.base64) {
        return null;
      }

      return {
        base64: photo.base64,
        mimeType: "image/jpeg",
      };
    } catch (err) {
      console.warn("[CameraAssistScreen] takePictureAsync failed:", err);
      return null;
    } finally {
      isTakingPictureRef.current = false;
    }
  }, []);

  // Register frame capture with service
  useEffect(() => {
    liveAssistService.registerFrameCapture(captureFrame);
    return () => {
      liveAssistService.registerFrameCapture(null);
    };
  }, [captureFrame]);

  // Initial welcome and auto-start
  const hasStartedRef = useRef<boolean>(false);
  useEffect(() => {
    if (hasStartedRef.current) return;

    const permState = resolveCameraPermissionState(permission);
    if (permState === "granted" && initialAutoStart) {
      hasStartedRef.current = true;
      (async () => {
        await liveAssistService.startLiveAssist();
      })();
    } else if (permState === "denied") {
      speechService.speak(
        "Camera permission is required for Scene Understanding. Tap the center button to request permission.",
        { force: true }
      );
    }

    return () => {
      // Safe lifecycle cleanup on unmount
      liveAssistService.cleanup();
    };
  }, [permission, initialAutoStart]);

  // Permission handling
  const handleRequestPermission = async () => {
    await hapticsService.triggerButtonPress();
    try {
      const resp = await requestPermission();
      if (resp && resp.granted) {
        await liveAssistService.startLiveAssist();
      } else {
        await speechService.speak(
          "Camera permission denied. Please enable camera access in phone Settings to use Scene Understanding.",
          { force: true }
        );
      }
    } catch {
      await speechService.speak("Failed to request camera permission. Please check Settings.", {
        force: true,
      });
    }
  };

  // 1. TOP-LEFT CORNER: Describe Now (Tap) / What Changed? (Long Press)
  const handleTopLeftPress = async () => {
    await hapticsService.triggerTopLeft();
    await liveAssistService.describeNow("Describe what is visibly in front of me on this campus.");
  };

  const handleTopLeftLongPress = async () => {
    await hapticsService.triggerTopLeft();
    await liveAssistService.whatChanged();
  };

  // 2. TOP-RIGHT CORNER: Pause / Resume Live Streaming
  const handleTopRightPress = async () => {
    await hapticsService.triggerTopRight();
    if (assistState.isSamplingActive) {
      await liveAssistService.pauseLiveAssist();
    } else {
      await liveAssistService.resumeLiveAssist();
    }
  };

  // 3. BOTTOM-LEFT CORNER: Stop / Silence (Tap) / Exit Back (Long Press)
  const handleBottomLeftPress = async () => {
    await hapticsService.triggerBottomLeft();
    await liveAssistService.stop();
  };

  const handleBottomLeftLongPress = async () => {
    await hapticsService.triggerBottomLeft();
    await liveAssistService.stop();
    onNavigateBack();
  };

  // 4. BOTTOM-RIGHT CORNER: Where Are My Keys? (Tap) / Voice Question (Long Press)
  const handleBottomRightPress = async () => {
    await hapticsService.triggerBottomRight();
    // Targeted visual search for keys with frame-relative grounding
    await liveAssistService.searchTargetObject("keys");
  };

  const handleBottomRightLongPress = async () => {
    await hapticsService.triggerBottomRight();
    await speechService.speak("Listening. Ask what is ahead or where an object is.", { force: true });
    // Toggle global voice input
    globalVoiceService.enableVoiceMode();
  };

  const handleBack = async () => {
    await hapticsService.triggerBottomLeft();
    await liveAssistService.stop();
    onNavigateBack();
  };

  const permState = resolveCameraPermissionState(permission);

  // If permission is confirmed denied
  if (permState === "denied") {
    return (
      <View style={[styles.permissionContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Ionicons name="camera-reverse-outline" size={64} color="#EF4444" style={styles.permissionIcon} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionBody}>
          Saarthi Scene Understanding requires camera access to analyze your surroundings, identify room signs, and locate objects.
        </Text>
        <Pressable
          onPress={handleRequestPermission}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Grant Camera Permission"
          accessibilityHint="Double-tap to request camera access"
          style={styles.permissionButton}
        >
          <Text style={styles.permissionButtonText}>Grant Camera Access</Text>
        </Pressable>
        <Pressable
          onPress={handleBack}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Return to Previous Screen"
          style={styles.permissionBackButton}
        >
          <Text style={styles.permissionBackButtonText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  // Dynamic inset calculations: add 16dp clearance beyond hardware notches/gesture bars
  const topInset = Math.max(insets.top, 16) + 12;
  const bottomInset = Math.max(insets.bottom, 16) + 12;
  const leftInset = Math.max(insets.left, 16) + 12;
  const rightInset = Math.max(insets.right, 16) + 12;

  return (
    <View style={styles.container}>
      {/* 1. Real Rear Camera Preview Layer */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="picture"
        onCameraReady={() => setIsCameraReady(true)}
      />

      {/* 2. Accessible Visual Frame & Reticle for Low-Vision Sighting */}
      <View style={styles.viewfinderContainer} pointerEvents="none">
        <View style={styles.reticleCornerTopLeft} />
        <View style={styles.reticleCornerTopRight} />
        <View style={styles.reticleCornerBottomLeft} />
        <View style={styles.reticleCornerBottomRight} />
        <View style={styles.centerCrosshairHorizontal} />
        <View style={styles.centerCrosshairVertical} />
      </View>

      {/* 3. Center HUD Display for Observation, Search Results & Safety Notes */}
      <View
        style={[
          styles.centerHudContainer,
          {
            paddingTop: topInset + 80,
            paddingBottom: bottomInset + 80,
          },
        ]}
        pointerEvents="box-none"
      >
        {/* Status Pill for Sighted Helpers */}
        <View style={styles.statusPill} accessible={true} accessibilityRole="header">
          <View
            style={[
              styles.statusIndicatorDot,
              assistState.isAnalyzing
                ? styles.statusDotAnalyzing
                : assistState.isSearching
                ? styles.statusDotSearching
                : assistState.isSamplingActive
                ? styles.statusDotActive
                : styles.statusDotPaused,
            ]}
          />
          <Text style={styles.statusPillTitle}>
            {assistState.isAnalyzing
              ? "ANALYZING VIEW"
              : assistState.isSearching
              ? `SEARCHING FOR ${assistState.activeTargetObject?.toUpperCase() || "OBJECT"}`
              : assistState.isSamplingActive
              ? "SCENE UNDERSTANDING ACTIVE"
              : "STREAM PAUSED"}
          </Text>
          <Text style={styles.statusPillSubtitle}>
            {assistState.connectionMode === "live_websocket" ? "Live Stream (1 FPS)" : "REST Fallback"}
          </Text>
        </View>

        {/* In-Flight Analysis Spinner */}
        {assistState.isAnalyzing && (
          <View style={styles.analyzingPill} accessible={true} accessibilityRole="progressbar">
            <ActivityIndicator size="small" color="#38BDF8" style={{ marginRight: 8 }} />
            <Text style={styles.analyzingText}>Analyzing view...</Text>
          </View>
        )}

        {/* Error Notice Banner */}
        {assistState.error && !assistState.isAnalyzing && (
          <View style={styles.errorPill} accessible={true} accessibilityRole="alert">
            <Ionicons name="alert-circle" size={18} color="#EF4444" style={{ marginRight: 6 }} />
            <Text style={styles.errorPillText} numberOfLines={2}>
              {assistState.error}
            </Text>
          </View>
        )}

        {/* Latest Spoken Observation & Grounded Position Card */}
        <View
          style={styles.observationCard}
          accessible={true}
          accessibilityRole="text"
          accessibilityLabel={`Observation: ${
            assistState.latestDescription || "Point camera steady at doors, tables, or obstacles."
          }`}
        >
          <View style={styles.observationHeaderRow}>
            <Ionicons name="eye" size={18} color="#38BDF8" />
            <Text style={styles.observationHeaderTitle}>
              {assistState.isSearching ? "SEARCH RESULT" : "LATEST OBSERVATION"}
            </Text>
            {assistState.suppressedCount > 0 && (
              <Text style={styles.suppressedBadge}>
                {assistState.suppressedCount} duplicate{assistState.suppressedCount > 1 ? "s" : ""} suppressed
              </Text>
            )}
          </View>

          <Text style={styles.observationText} numberOfLines={4}>
            {assistState.latestDescription ||
              "Saarthi scene understanding is active. Point your camera forward; ask me anything."}
          </Text>

          {assistState.lastSearchResult && (
            <View
              style={[
                styles.groundedPositionBadge,
                assistState.lastSearchResult.is_found
                  ? styles.positionFoundBadge
                  : styles.positionSearchingBadge,
              ]}
            >
              <Ionicons
                name={assistState.lastSearchResult.is_found ? "checkmark-circle" : "search"}
                size={16}
                color={assistState.lastSearchResult.is_found ? "#22C55E" : "#FACC15"}
              />
              <Text style={styles.groundedPositionText}>
                {assistState.lastSearchResult.is_found
                  ? `Found ${assistState.lastSearchResult.target_object}: ${assistState.lastSearchResult.relative_frame_position || "in view"}`
                  : `Scanning: Slowly sweep across nearby surfaces`}
              </Text>
            </View>
          )}

          <Text style={styles.safetyDisclaimerText}>
            Safety Note: Low ground obstacles and drop-offs below camera view are not checked.
          </Text>
        </View>
      </View>

      {/* ==============================================================================
          4-CORNER TACTILE INTERFACE (NON-NEGOTIABLE WCAG AAA ACCESSIBILITY)
          Fixed spatial corners so blind users can locate buttons instantly by tactile hand position.
      ============================================================================== */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* 1. TOP-LEFT: Describe Now (Tap) / What Changed? (Long Press) */}
        <View style={[styles.cornerWrapper, { top: topInset, left: leftInset }]} pointerEvents="box-none">
          <Pressable
            onPress={handleTopLeftPress}
            onLongPress={handleTopLeftLongPress}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Describe Now. Top-left corner. Tap to inspect view immediately. Long press to ask what changed."
            accessibilityHint="Captures photo and reads current scene description aloud"
            hitSlop={12}
            style={({ pressed }) => [
              styles.cornerButton,
              styles.topLeftButton,
              pressed && styles.buttonPressed,
              assistState.isAnalyzing && styles.buttonDisabled,
            ]}
          >
            <Ionicons name="eye" size={36} color="#FFFFFF" />
          </Pressable>
          <Text style={styles.cornerLabel} maxFontSizeMultiplier={1.8}>
            Describe Now
          </Text>
        </View>

        {/* 2. TOP-RIGHT: Pause / Resume Live Stream */}
        <View style={[styles.cornerWrapper, { top: topInset, right: rightInset }]} pointerEvents="box-none">
          <Pressable
            onPress={handleTopRightPress}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={
              assistState.isSamplingActive
                ? "Pause Live Stream. Top-right corner. Double-tap to pause automatic periodic updates."
                : "Resume Live Stream. Top-right corner. Double-tap to resume automatic periodic updates."
            }
            accessibilityHint="Toggles continuous camera scene sampling"
            hitSlop={12}
            style={({ pressed }) => [
              styles.cornerButton,
              styles.topRightButton,
              pressed && styles.buttonPressed,
              assistState.isSamplingActive && styles.activeSamplingButton,
            ]}
          >
            <Ionicons
              name={assistState.isSamplingActive ? "pause" : "play"}
              size={36}
              color="#FFFFFF"
            />
          </Pressable>
          <Text style={styles.cornerLabel} maxFontSizeMultiplier={1.8}>
            {assistState.isSamplingActive ? "Pause" : "Live Stream"}
          </Text>
        </View>

        {/* 3. BOTTOM-LEFT: Stop Speech & Stream (Tap) / Exit Back (Long Press) */}
        <View style={[styles.cornerWrapper, { bottom: bottomInset, left: leftInset }]} pointerEvents="box-none">
          <Pressable
            onPress={handleBottomLeftPress}
            onLongPress={handleBottomLeftLongPress}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Stop. Bottom-left corner. Tap to silence speech and stop live stream. Long press to exit back to Home."
            accessibilityHint="Immediately cuts off speech audio and halts live streaming"
            hitSlop={12}
            style={({ pressed }) => [
              styles.cornerButton,
              styles.bottomLeftButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <View style={styles.stopIcon} />
          </Pressable>
          <Text style={styles.cornerLabel} maxFontSizeMultiplier={1.8}>
            Stop / Exit
          </Text>
        </View>

        {/* 4. BOTTOM-RIGHT: Where Are My Keys? (Tap) / Voice Question (Long Press) */}
        <View style={[styles.cornerWrapper, { bottom: bottomInset, right: rightInset }]} pointerEvents="box-none">
          <Pressable
            onPress={handleBottomRightPress}
            onLongPress={handleBottomRightLongPress}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={
              assistState.isSearching
                ? `Searching for ${assistState.activeTargetObject || "object"}. Bottom-right corner. Tap to re-check.`
                : "Where are my keys? Bottom-right corner. Double-tap to search for keys in camera frame. Long press to ask a custom question."
            }
            accessibilityHint="Searches for keys with camera sweep guidance and frame-relative location"
            accessibilityState={{ busy: assistState.isSearching }}
            hitSlop={12}
            style={({ pressed }) => [
              styles.cornerButton,
              styles.bottomRightButton,
              pressed && styles.buttonPressed,
              assistState.isSearching && styles.searchingButton,
            ]}
          >
            <Ionicons
              name={assistState.isSearching ? "search" : "key"}
              size={36}
              color="#FFFFFF"
            />
          </Pressable>
          <Text
            style={[styles.cornerLabel, assistState.isSearching && styles.searchingText]}
            maxFontSizeMultiplier={1.8}
          >
            {assistState.isSearching ? "Searching..." : "Find Keys"}
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: "#030712",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  permissionIcon: {
    marginBottom: 20,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: "#FFFFFF",
    textAlign: "center",
    marginBottom: 12,
  },
  permissionBody: {
    fontSize: 15,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  permissionButton: {
    width: "100%",
    minHeight: 56,
    backgroundColor: "#0284C7",
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
  },
  permissionButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  permissionBackButton: {
    width: "100%",
    minHeight: 56,
    backgroundColor: "#1E293B",
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  permissionBackButtonText: {
    color: "#94A3B8",
    fontSize: 15,
    fontWeight: "700",
  },
  viewfinderContainer: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
  },
  reticleCornerTopLeft: {
    position: "absolute",
    top: "24%",
    left: "14%",
    width: 28,
    height: 28,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(56, 189, 248, 0.75)",
  },
  reticleCornerTopRight: {
    position: "absolute",
    top: "24%",
    right: "14%",
    width: 28,
    height: 28,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(56, 189, 248, 0.75)",
  },
  reticleCornerBottomLeft: {
    position: "absolute",
    bottom: "24%",
    left: "14%",
    width: 28,
    height: 28,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(56, 189, 248, 0.75)",
  },
  reticleCornerBottomRight: {
    position: "absolute",
    bottom: "24%",
    right: "14%",
    width: 28,
    height: 28,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(56, 189, 248, 0.75)",
  },
  centerCrosshairHorizontal: {
    width: 36,
    height: 2,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
  },
  centerCrosshairVertical: {
    width: 2,
    height: 36,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
    position: "absolute",
  },
  centerHudContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  statusPill: {
    alignItems: "center",
    backgroundColor: "rgba(3, 7, 18, 0.88)",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: "#1E293B",
  },
  statusIndicatorDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    marginBottom: 4,
  },
  statusDotActive: {
    backgroundColor: "#22C55E",
  },
  statusDotAnalyzing: {
    backgroundColor: "#38BDF8",
  },
  statusDotSearching: {
    backgroundColor: "#FACC15",
  },
  statusDotPaused: {
    backgroundColor: "#F59E0B",
  },
  statusPillTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: "#FFFFFF",
    letterSpacing: 1.1,
  },
  statusPillSubtitle: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "600",
    marginTop: 2,
  },
  analyzingPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.94)",
    borderColor: "#38BDF8",
    borderWidth: 1.5,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: 8,
  },
  analyzingText: {
    color: "#38BDF8",
    fontSize: 13,
    fontWeight: "700",
  },
  errorPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(127, 29, 29, 0.92)",
    borderColor: "#EF4444",
    borderWidth: 1.5,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: 8,
    maxWidth: "90%",
  },
  errorPillText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  observationCard: {
    width: "100%",
    backgroundColor: "rgba(3, 7, 18, 0.92)",
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: "#1E293B",
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 10,
  },
  observationHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  observationHeaderTitle: {
    fontSize: 12,
    fontWeight: "900",
    color: "#38BDF8",
    letterSpacing: 1.0,
    marginLeft: 6,
    flex: 1,
  },
  suppressedBadge: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "600",
    backgroundColor: "#1E293B",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  observationText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#F8FAFC",
    lineHeight: 22,
    marginBottom: 8,
  },
  groundedPositionBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    marginBottom: 8,
    gap: 6,
  },
  positionFoundBadge: {
    backgroundColor: "rgba(34, 197, 94, 0.18)",
    borderWidth: 1,
    borderColor: "#22C55E",
  },
  positionSearchingBadge: {
    backgroundColor: "rgba(250, 204, 21, 0.18)",
    borderWidth: 1,
    borderColor: "#FACC15",
  },
  groundedPositionText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  safetyDisclaimerText: {
    fontSize: 11,
    color: "#64748B",
    fontStyle: "italic",
  },

  // 4-Corner Layout Styles
  cornerWrapper: {
    position: "absolute",
    alignItems: "center",
    width: 104,
  },
  cornerButton: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 9,
    borderWidth: 2.5,
    borderColor: "rgba(255, 255, 255, 0.4)",
  },
  buttonPressed: {
    transform: [{ scale: 0.93 }],
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  topLeftButton: {
    backgroundColor: "#0284C7", // High-contrast Blue
  },
  topRightButton: {
    backgroundColor: "#059669", // High-contrast Emerald
  },
  bottomLeftButton: {
    backgroundColor: "#DC2626", // High-contrast Red
  },
  bottomRightButton: {
    backgroundColor: "#7C3AED", // High-contrast Purple
  },
  activeSamplingButton: {
    borderColor: "#4ADE80",
    borderWidth: 3.5,
    shadowColor: "#22C55E",
    shadowOpacity: 0.8,
  },
  searchingButton: {
    backgroundColor: "#9333EA",
    borderColor: "#FACC15",
    borderWidth: 3.5,
    shadowColor: "#FACC15",
    shadowOpacity: 0.9,
    shadowRadius: 16,
  },
  stopIcon: {
    width: 26,
    height: 26,
    backgroundColor: "#FFFFFF",
    borderRadius: 5,
  },
  cornerLabel: {
    marginTop: 8,
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 0.2,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 3,
  },
  searchingText: {
    color: "#FACC15",
  },
});
