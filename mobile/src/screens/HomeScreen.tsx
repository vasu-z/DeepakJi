import React, { useState, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { readingPipeline } from "../services/readingPipeline";
import { checkBackendHealth, getAiStatus } from "../api/client";
import { NextClassResult, getNextClass } from "../utils/dateTimeReasoning";
import { NavigationRoute } from "../navigation/campusRouter";

// Shared Corner Geometry Constants
const OUTER_CORNER_RADIUS = 28;
const INNER_SWEEP_RADIUS = 100;
const BORDER_WIDTH = 1.5;
const GRID_GAP = 14;
const SCREEN_PADDING = 16;

// Symmetrical mirrored corner radii configurations
const CORNER_RADII = {
  topLeft: {
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: INNER_SWEEP_RADIUS, // Sweeps inward toward center
  },
  topRight: {
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: INNER_SWEEP_RADIUS, // Sweeps inward toward center
  },
  bottomLeft: {
    borderTopLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderTopRightRadius: INNER_SWEEP_RADIUS, // Sweeps inward toward center
  },
  bottomRight: {
    borderTopRightRadius: OUTER_CORNER_RADIUS,
    borderBottomLeftRadius: OUTER_CORNER_RADIUS,
    borderBottomRightRadius: OUTER_CORNER_RADIUS,
    borderTopLeftRadius: INNER_SWEEP_RADIUS, // Sweeps inward toward center
  },
} as const;

// Symmetrical color tokens with matched luminous borders
const CORNER_THEMES = {
  topLeft: {
    backgroundColor: "#005CE6", // Royal Blue
    borderColor: "#38BDF8",
    shadowColor: "#0066FF",
  },
  topRight: {
    backgroundColor: "#00A84D", // Emerald Green
    borderColor: "#4ADE80",
    shadowColor: "#00E676",
  },
  bottomLeft: {
    backgroundColor: "#FF5500", // Amber Orange
    borderColor: "#FB923C",
    shadowColor: "#FF6D00",
  },
  bottomRight: {
    backgroundColor: "#7525E6", // Vivid Purple
    borderColor: "#C084FC",
    shadowColor: "#A855F7",
  },
} as const;

interface CornerTileProps {
  position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
  icon: keyof typeof Ionicons.glyphMap;
  line1: string;
  line2: string;
  onPress: () => Promise<void> | void;
  onLongPress?: () => Promise<void> | void;
  accessibilityLabel: string;
  accessibilityHint: string;
}

const CornerTile: React.FC<CornerTileProps> = ({
  position,
  icon,
  line1,
  line2,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
}) => {
  const theme = CORNER_THEMES[position];
  const radii = CORNER_RADII[position];

  return (
    <View style={styles.tileOuterWrapper}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        style={({ pressed }) => [
          styles.tileBase,
          radii,
          {
            backgroundColor: theme.backgroundColor,
            borderColor: theme.borderColor,
            shadowColor: theme.shadowColor,
          },
          pressed && styles.tilePressed,
        ]}
      >
        <Ionicons name={icon} size={46} color="#FFFFFF" style={styles.tileIcon} />
        <View style={styles.labelWrapper}>
          <Text style={styles.tileTitle}>{line1}</Text>
          <Text style={styles.tileTitle}>{line2}</Text>
        </View>
      </Pressable>
    </View>
  );
};

export interface HomeScreenProps {
  onNavigate: (
    screen: "home" | "reader" | "results" | "timetable" | "navigation" | "voice" | "settings" | "assist",
    params?: any
  ) => void;
  activeRoute: NavigationRoute | null;
  onCancelRoute: () => void;
  onRepeatRouteStep: () => void;
  isVoiceModeActive?: boolean;
  onToggleVoiceMode?: () => void;
  showOnboarding?: boolean;
  onDismissOnboarding?: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  onNavigate,
  activeRoute,
  onCancelRoute,
  onRepeatRouteStep,
  isVoiceModeActive = false,
  onToggleVoiceMode,
  showOnboarding = false,
  onDismissOnboarding,
}) => {
  const insets = useSafeAreaInsets();
  const [backendStatus, setBackendStatus] = useState<"checking" | "connected" | "offline">("checking");
  const [backendLatency, setBackendLatency] = useState<number | null>(null);
  const [isAiConfigured, setIsAiConfigured] = useState<boolean>(false);
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  const [aiModel, setAiModel] = useState<string>("Gemma 4");
  const [nextClass, setNextClass] = useState<NextClassResult | null>(null);

  // Check real backend status & next class schedule
  const refreshStatus = useCallback(async () => {
    try {
      const timetable = await readingPipeline.getStoredTimetable();
      const next = getNextClass(timetable, new Date());
      setNextClass(next);
    } catch {
      setNextClass(null);
    }

    const startTime = Date.now();
    let isConnected = false;
    try {
      const health = await checkBackendHealth();
      const latency = Date.now() - startTime;
      const isHealthy = health.status === "ok" || health.status === "healthy";
      if (isHealthy) {
        isConnected = true;
        setBackendStatus("connected");
        setBackendLatency(latency);
      } else {
        setBackendStatus("offline");
        setBackendLatency(null);
      }
    } catch {
      setBackendStatus("offline");
      setBackendLatency(null);
    }

    if (isConnected) {
      try {
        const ai = await getAiStatus();
        setIsAiConfigured(Boolean(ai.configured));
        setIsMockMode(Boolean(ai.mock_mode));
        if (ai.model) {
          setAiModel(ai.model);
        }
      } catch {
        setIsAiConfigured(false);
        setIsMockMode(false);
      }
    } else {
      setIsAiConfigured(false);
      setIsMockMode(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Corner Tile Handlers with Distinct Haptic Signatures
  const handleReadCampusText = async () => {
    await hapticsService.triggerTopLeft();
    onNavigate("reader");
  };

  const handleCampusNavigation = async () => {
    await hapticsService.triggerTopRight();
    onNavigate("navigation");
  };

  const handleMyTimetable = async () => {
    await hapticsService.triggerBottomLeft();
    onNavigate("timetable");
  };

  const handleVoiceAssistant = async () => {
    await hapticsService.triggerBottomRight();
    if (onToggleVoiceMode) {
      onToggleVoiceMode();
    } else {
      onNavigate("voice");
    }
  };

  const handleAnnounceStatus = async () => {
    await hapticsService.triggerTopLeft();
    let message = "";
    if (backendStatus === "connected") {
      if (isMockMode) {
        message = `Backend connected in mock mode. Latency: ${backendLatency ?? 0} milliseconds.`;
      } else if (isAiConfigured) {
        message = `Backend connected with live ${aiModel} vision ready. Latency: ${backendLatency ?? 0} milliseconds.`;
      } else {
        message = `Backend connected. AI key not configured. Latency: ${backendLatency ?? 0} milliseconds.`;
      }
    } else if (backendStatus === "checking") {
      message = "Checking backend connection status...";
    } else {
      message = "Backend is offline. Local campus navigation and timetable remain active offline.";
    }
    await speechService.speak(message, { force: true });
  };

  // Soundwave heights & gradient colors matching reference design
  const waveHeights = [12, 20, 32, 22, 42, 22, 32, 20, 12];
  const waveColors = [
    "#38BDF8",
    "#60A5FA",
    "#818CF8",
    "#A78BFA",
    "#C084FC",
    "#A78BFA",
    "#818CF8",
    "#60A5FA",
    "#38BDF8",
  ];

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: Math.max(insets.top, 8),
          paddingBottom: Math.max(insets.bottom, 12),
        },
      ]}
      accessible={false}
    >
      {/* 1. Subtle Header: Diagnostic Status Pill & Settings Access */}
      <View style={styles.topHeader}>
        <Pressable
          onPress={handleAnnounceStatus}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={
            backendStatus === "connected"
              ? isMockMode
                ? "Backend connected in developer mock mode. Double-tap to hear details."
                : `Backend connected. Live ${aiModel} AI ready. Double-tap to hear details.`
              : "Backend offline. Double-tap to hear details."
          }
          accessibilityHint="Speaks connection and AI model diagnostic status"
          style={styles.statusPill}
        >
          <View
            style={[
              styles.statusDot,
              backendStatus === "connected"
                ? isMockMode
                  ? styles.statusDotAmber
                  : styles.statusDotGreen
                : styles.statusDotRed,
            ]}
          />
          <Text style={styles.statusPillText}>
            {backendStatus === "checking"
              ? "Checking..."
              : backendStatus === "connected"
              ? isMockMode
                ? "Mock Mode"
                : isAiConfigured
                ? "AI Online"
                : "Connected"
              : "Offline"}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => onNavigate("settings")}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          accessibilityHint="Double-tap to configure server URL, speech options, and app settings"
          style={styles.settingsButton}
          hitSlop={8}
        >
          <Ionicons name="settings-outline" size={18} color="#94A3B8" />
        </Pressable>
      </View>

      {/* 2. First-Launch Onboarding Notice */}
      {showOnboarding && (
        <View
          style={styles.onboardingBanner}
          accessible={true}
          accessibilityRole="alert"
          accessibilityLabel="Welcome to SAARTHI! Tap the purple Voice Assistant tile at the bottom right to activate voice control. Then speak naturally to navigate the app."
        >
          <View style={styles.onboardingIconWrap}>
            <Ionicons name="sparkles" size={20} color="#C084FC" />
          </View>
          <View style={styles.onboardingTextWrap}>
            <Text style={styles.onboardingTitle}>Welcome to SAARTHI</Text>
            <Text style={styles.onboardingBody}>
              Tap the purple Voice Assistant tile at the bottom right to activate voice control. Then speak naturally to navigate the app.
            </Text>
          </View>
          {onDismissOnboarding && (
            <Pressable
              onPress={onDismissOnboarding}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Dismiss welcome instructions"
              accessibilityHint="Closes this onboarding announcement"
              style={styles.onboardingDismissButton}
              hitSlop={8}
            >
              <Ionicons name="close" size={18} color="#94A3B8" />
            </Pressable>
          )}
        </View>
      )}

      {/* 3. Active Route Notice (if walking route in progress) */}
      {activeRoute && (
        <View style={styles.activeRouteBanner} accessible={true} accessibilityRole="alert">
          <View style={styles.activeRouteInfo}>
            <Ionicons name="navigate-circle" size={18} color="#00E676" />
            <Text style={styles.activeRouteText} numberOfLines={1}>
              Active Route to {activeRoute.steps[activeRoute.steps.length - 1]?.toNode.label || "Destination"}
            </Text>
          </View>
          <View style={styles.activeRouteActions}>
            <Pressable
              onPress={() => onNavigate("navigation")}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Resume active route guidance"
              style={styles.activeRouteResumeButton}
            >
              <Text style={styles.activeRouteResumeText}>Resume</Text>
            </Pressable>
            <Pressable
              onPress={onCancelRoute}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Cancel active navigation route"
              style={styles.activeRouteCancelButton}
            >
              <Ionicons name="close" size={16} color="#94A3B8" />
            </Pressable>
          </View>
        </View>
      )}

      {/* 3. Main 4-Panel Framing Area (Top Tiles, Center Branding, Bottom Tiles) */}
      <View style={styles.mainFramingContainer}>
        {/* Top Row: Read Anything (Left) & Campus Map (Right) */}
        <View style={styles.tilesRow}>
          <CornerTile
            position="topLeft"
            icon="camera"
            line1="Read"
            line2="Anything"
            onPress={handleReadCampusText}
            onLongPress={async () => {
              await hapticsService.triggerTopLeft();
              onNavigate("assist");
            }}
            accessibilityLabel="Read Anything. Top-left corner. Double-tap to open camera and read text, door signs, notice boards, or class timetables. Long-press to launch Live Scene Understanding."
            accessibilityHint="Opens camera reader with automatic text and timetable extraction, or long press for Live Scene Understanding"
          />

          <CornerTile
            position="topRight"
            icon="navigate"
            line1="Campus"
            line2="Map"
            onPress={handleCampusNavigation}
            accessibilityLabel="Campus Map. Top-right corner. Double-tap to open interactive campus map, live GPS location, destination search, and walking navigation."
            accessibilityHint="Opens interactive campus map and real-time navigation"
          />
        </View>

        {/* Center Section: SAARTHI Campus Mode Branding & Honest Voice State */}
        <View style={styles.centerBrandingSection} accessible={true} accessibilityRole="header">
          <Text style={styles.brandTitle}>SAARTHI</Text>
          <Text style={styles.brandSubtitle}>CAMPUS MODE</Text>

          {/* Audio Indicator: Real state only (never fake wave when inactive) */}
          {isVoiceModeActive ? (
            <View style={styles.soundwaveContainer} accessibilityLabel="Voice active indicator">
              {waveHeights.map((h, i) => (
                <View
                  key={i}
                  style={[
                    styles.soundwaveBar,
                    {
                      height: h,
                      backgroundColor: waveColors[i],
                    },
                  ]}
                />
              ))}
            </View>
          ) : (
            <View style={styles.voiceStandbyContainer} accessibilityLabel="Voice assistant standby">
              <Ionicons name="mic-outline" size={16} color="#64748B" />
              <Text style={styles.voiceStandbyText}>Voice standby • Tap bottom-right to speak</Text>
            </View>
          )}
        </View>

        {/* Bottom Row: My Day (Left) & Talk to Saarthi (Right) */}
        <View style={styles.tilesRow}>
          <CornerTile
            position="bottomLeft"
            icon="calendar"
            line1="My"
            line2="Day"
            onPress={handleMyTimetable}
            accessibilityLabel={
              nextClass && nextClass.entry
                ? `My Day. Bottom-left corner. Next confirmed class is ${nextClass.entry.courseName} at ${nextClass.entry.startTime} in ${nextClass.entry.room}. Double-tap to view confirmed schedule.`
                : "My Day. Bottom-left corner. No confirmed classes scheduled right now. Double-tap to view and manage confirmed schedule."
            }
            accessibilityHint="Opens confirmed daily schedule and next class information"
          />

          <CornerTile
            position="bottomRight"
            icon={isVoiceModeActive ? "mic" : "mic-outline"}
            line1="Talk to"
            line2="Saarthi"
            onPress={handleVoiceAssistant}
            accessibilityLabel={
              isVoiceModeActive
                ? "Talk to Saarthi. Active. Bottom-right corner. Double-tap to turn voice assistant off."
                : "Talk to Saarthi. Bottom-right corner. Double-tap to activate voice assistant."
            }
            accessibilityHint={
              isVoiceModeActive
                ? "Turns off voice assistant"
                : "Activates push-to-talk voice assistant"
            }
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#030712", // Pure/near-black OLED background
    paddingHorizontal: SCREEN_PADDING,
  },
  mainFramingContainer: {
    flex: 1,
    justifyContent: "space-between",
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingVertical: 2,
    marginBottom: 6,
    minHeight: 32,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 6,
  },
  statusDotGreen: {
    backgroundColor: "#05DF72",
  },
  statusDotAmber: {
    backgroundColor: "#F59E0B",
  },
  statusDotRed: {
    backgroundColor: "#EF4444",
  },
  statusPillText: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  settingsButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  onboardingBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(117, 37, 230, 0.16)",
    borderWidth: 1.5,
    borderColor: "#A855F7",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    gap: 10,
  },
  onboardingIconWrap: {
    paddingTop: 2,
  },
  onboardingTextWrap: {
    flex: 1,
  },
  onboardingTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  onboardingBody: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  onboardingDismissButton: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
  },
  activeRouteBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(5, 223, 114, 0.12)",
    borderWidth: 1,
    borderColor: "#05DF72",
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  activeRouteInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: 8,
    gap: 6,
  },
  activeRouteText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  activeRouteActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  activeRouteResumeButton: {
    backgroundColor: "#05DF72",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  activeRouteResumeText: {
    color: "#030712",
    fontSize: 12,
    fontWeight: "800",
  },
  activeRouteCancelButton: {
    padding: 4,
  },

  // Responsive 2-Column Grid Rows
  tilesRow: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: GRID_GAP,
    minHeight: 190,
  },
  tileOuterWrapper: {
    flex: 1,
    height: "100%",
  },
  tileBase: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 18,
    borderWidth: BORDER_WIDTH,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 16,
    elevation: 6,
  },
  tilePressed: {
    opacity: 0.88,
    transform: [{ scale: 0.97 }],
  },
  tileIcon: {
    marginBottom: 14,
  },
  labelWrapper: {
    alignItems: "center",
  },
  tileTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 22,
    letterSpacing: 0.2,
  },

  // Center Branding & Audio Waveform Section
  centerBrandingSection: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    minHeight: 140,
  },
  brandTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 2.5,
    textAlign: "center",
  },
  brandSubtitle: {
    color: "#F1F5F9",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 4.5,
    textAlign: "center",
    marginTop: 6,
  },
  soundwaveContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 46,
    marginTop: 14,
    gap: 4.5,
  },
  soundwaveBar: {
    width: 4.5,
    borderRadius: 3,
  },
  voiceStandbyContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    borderRadius: 16,
    marginTop: 14,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  voiceStandbyText: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
});
