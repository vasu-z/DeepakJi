import {
  ParsedVoiceCommand,
  parseVoiceCommand,
  SCREEN_INTENT_MAP,
  NavigationIntentType,
} from "./voiceCommands";
import {
  describeWhereAmI,
  describeWhatCanIDo,
  getScreenRegistryEntry,
  SCREEN_REGISTRY,
} from "../navigation/screenRegistry";
import type { AppScreen } from "../../App";
import { speechService } from "./speech";
import { readingPipeline, ReadingPipelineResult } from "./readingPipeline";
import { liveAssistService } from "./liveAssistService";

export interface VoiceCommandDispatchContext {
  currentScreen: AppScreen;
  screenHistory?: AppScreen[];
  hasReadingResult?: boolean;
  isCapturing?: boolean;
  currentReadingResult?: ReadingPipelineResult | null;
  onNavigateToScreen?: (screen: AppScreen) => void;
  onNavigateBack?: () => AppScreen | boolean | void | null;
  onNavigateToReader?: (mode?: "auto" | "timetable" | "sign" | "notice") => void;
  onNavigateToAssist?: () => void;
  onNavigateToNavigation?: (destinationQuery?: string) => void;
  onNavigateToTimetable?: () => void;
  onTriggerScan?: () => Promise<void> | void;
  onReadFullText?: () => Promise<void> | void;
  onSummarizeResult?: () => Promise<void> | void;
  onScanAgain?: () => void;
  onStopListening?: () => void;
  onResumeListening?: () => void;
  onExitVoiceMode?: () => void;
  onMapSearchDestination?: (query: string) => Promise<void> | void;
  onMapSearchNearby?: (category: string) => Promise<void> | void;
  onMapStopNavigation?: () => Promise<void> | void;
  onMapRepeatInstruction?: () => Promise<void> | void;
  onMapRecenter?: () => Promise<void> | void;
  onMapWhereAmI?: () => Promise<void> | void;
  onMapGetStatus?: () => Promise<void> | void;
}


/**
 * Dispatches a recognized or typed voice command using the actual active screen context.
 *
 * Implements Phase 1 Screen Awareness & Phase 2 Global Voice Navigation:
 * - "Open <Screen>" / "Go <Screen>": Dynamically navigates to the target screen and speaks confirmation.
 * - "Go Back" / "Back": Safely pops navigation history, preventing loops and duplicate entries.
 * - "Where am I?": Dynamically speaks the registered description and purpose of the current screen.
 * - "What can I do here?" / "Help": Dynamically speaks the genuinely available actions on the current screen.
 * - "Repeat that": Replays the last spoken message using the existing speech service buffer.
 * - "Stop": Immediately cuts off any active speech output.
 */
export async function dispatchVoiceCommand(
  input: string | ParsedVoiceCommand,
  context: VoiceCommandDispatchContext
): Promise<string> {
  const parsed = typeof input === "string" ? parseVoiceCommand(input) : input;
  const currentScreen = context.currentScreen || "home";

  switch (parsed.intent) {
    case "stop_listening": {
      context.onStopListening?.();
      const msg = "Listening paused. Tap the voice button to resume.";
      await speechService.speak(msg, { force: true });
      return msg;
    }

    case "resume_listening": {
      context.onResumeListening?.();
      const msg = "Listening resumed.";
      await speechService.speak(msg, { force: true });
      return msg;
    }

    case "exit_voice_mode": {
      context.onExitVoiceMode?.();
      const msg = "Voice mode is off.";
      await speechService.speak(msg, { force: true });
      return msg;
    }

    case "stop_navigation": {
      if (context.onMapStopNavigation) {
        await context.onMapStopNavigation();
        return "Navigation stopped.";
      }
      const msg = "Campus navigation is not currently active.";
      await speechService.speak(msg, { force: true });
      return msg;
    }

    case "recenter_map": {
      if (context.onMapRecenter) {
        await context.onMapRecenter();
        return "Map recentered.";
      } else if (context.onNavigateToNavigation) {
        context.onNavigateToNavigation();
        const msg = "Opening campus map.";
        await speechService.speak(msg, { force: true });
        return msg;
      }
      return "Map recenter unavailable.";
    }

    case "navigation_status": {
      if (context.onMapGetStatus) {
        await context.onMapGetStatus();
        return "Checking route status.";
      }
      const msg = "Navigation is not active. Say take me to a destination to begin.";
      await speechService.speak(msg, { force: true });
      return msg;
    }

    case "nearby_places": {
      const cat = parsed.categoryQuery || "places";
      if (currentScreen === "navigation" && context.onMapSearchNearby) {
        await context.onMapSearchNearby(cat);
        return `Searching nearby ${cat}.`;
      } else if (context.onNavigateToNavigation) {
        context.onNavigateToNavigation();
        if (context.onMapSearchNearby) {
          await context.onMapSearchNearby(cat);
        } else {
          const msg = `Opening campus map to search nearby ${cat}.`;
          await speechService.speak(msg, { force: true });
        }
        return `Searching nearby ${cat}.`;
      }
      return `Searching nearby ${cat}.`;
    }

    case "stop": {
      await speechService.stop();
      return "Stopped speaking.";
    }

    case "repeat": {
      if (currentScreen === "navigation" && context.onMapRepeatInstruction) {
        await context.onMapRepeatInstruction();
        return "Repeating navigation instruction.";
      }
      const ok = await speechService.repeatLast();
      if (!ok) {
        const msg = "Nothing to repeat yet.";
        await speechService.speak(msg, { force: true });
        return msg;
      }
      return "Replaying last message.";
    }


    case "scan_now": {
      if (context.isCapturing) {
        const msg = "A scan is already in progress. Please wait.";
        await speechService.speak(msg, { force: true });
        return msg;
      }

      if (currentScreen !== "reader") {
        const spokenMsg = "Opening camera in Auto Read mode. Say 'scan now' when ready.";
        await speechService.speak(spokenMsg, { force: true });
        if (context.onNavigateToReader) {
          context.onNavigateToReader("auto");
        } else if (context.onNavigateToScreen) {
          context.onNavigateToScreen("reader");
        }
        return spokenMsg;
      }

      if (context.onTriggerScan) {
        await context.onTriggerScan();
        return "Scan initiated.";
      } else {
        const notReady = "Camera is not ready yet. Please wait a moment.";
        await speechService.speak(notReady, { force: true });
        return notReady;
      }
    }

    case "read_full_text": {
      if (context.onReadFullText) {
        await context.onReadFullText();
        return "Reading full text.";
      }

      const sourceText =
        context.currentReadingResult?.response?.source_text?.trim() ||
        context.currentReadingResult?.response?.spoken_summary?.trim();

      if (!sourceText) {
        const noTextMsg =
          "No text was detected in the latest scan. Say 'scan again' to try another scan.";
        await speechService.speak(noTextMsg, { force: true });
        return noTextMsg;
      }

      const fullSpoken = `Full text: ${sourceText}`;
      await speechService.speak(fullSpoken, { force: true });
      return fullSpoken;
    }

    case "summarize_this": {
      if (context.onSummarizeResult) {
        await context.onSummarizeResult();
        return "Reading summary.";
      }

      const summary =
        context.currentReadingResult?.response?.spoken_summary?.trim();

      if (!summary) {
        const noSummaryMsg =
          "No summary is available for this scan. Say 'scan again' to try another scan.";
        await speechService.speak(noSummaryMsg, { force: true });
        return noSummaryMsg;
      }

      const summarySpoken = `Summary: ${summary}`;
      await speechService.speak(summarySpoken, { force: true });
      return summarySpoken;
    }

    case "scan_again": {
      const msg = "Returning to camera. Say 'scan now' when ready.";
      await speechService.speak(msg, { force: true });

      if (context.onScanAgain) {
        context.onScanAgain();
      } else if (context.onNavigateToReader) {
        context.onNavigateToReader("auto");
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("reader");
      }

      return msg;
    }

    case "where_am_i": {
      if (currentScreen === "navigation" && context.onMapWhereAmI) {
        await context.onMapWhereAmI();
        return "Describing current location.";
      }
      const response = describeWhereAmI(currentScreen);
      await speechService.speak(response, { force: true });
      return response;
    }


    case "what_can_i_do": {
      const response = describeWhatCanIDo(currentScreen);
      await speechService.speak(response, { force: true });
      return response;
    }

    // Phase 2: Global Voice Navigation
    case "open_home":
    case "open_reader":
    case "open_results":
    case "open_timetable":
    case "open_navigation":
    case "open_voice":
    case "open_settings":
    case "open_assist": {
      const targetScreen: AppScreen =
        parsed.targetScreen ||
        SCREEN_INTENT_MAP[parsed.intent as NavigationIntentType] ||
        "home";

      const targetEntry = getScreenRegistryEntry(targetScreen);

      // Check if already on the target screen
      if (currentScreen === targetScreen) {
        if (targetScreen === "reader" && context.onTriggerScan && !context.isCapturing) {
          await context.onTriggerScan();
          return "Scan initiated.";
        }
        const alreadyMsg = `You are already on the ${targetEntry.screenName} screen.`;
        await speechService.speak(alreadyMsg, { force: true });
        return alreadyMsg;
      }

      // Check if trying to view results with no scan available
      if (targetScreen === "results" && context.hasReadingResult === false) {
        const noResultMsg =
          "No reading results available yet. Please scan a document or sign first.";
        await speechService.speak(noResultMsg, { force: true });
        return noResultMsg;
      }

      // Spoken confirmation
      const spokenMsg = `Opening ${targetEntry.screenName}.`;
      await speechService.speak(spokenMsg, { force: true });

      // Trigger navigation callback
      if (context.onNavigateToScreen) {
        context.onNavigateToScreen(targetScreen);
      } else {
        // Fallback to legacy callbacks
        if (targetScreen === "reader") {
          context.onNavigateToReader?.("auto");
        } else if (targetScreen === "navigation") {
          context.onNavigateToNavigation?.("");
        } else if (targetScreen === "timetable") {
          context.onNavigateToTimetable?.();
        } else if (targetScreen === "home") {
          context.onNavigateBack?.();
        }
      }

      return spokenMsg;
    }

    case "go_back": {
      let backResult: AppScreen | boolean | void | null = undefined;
      if (context.onNavigateBack) {
        backResult = context.onNavigateBack();
      }

      // If at root of history and on home
      if (
        backResult === false ||
        backResult === null ||
        (context.screenHistory &&
          context.screenHistory.length === 0 &&
          currentScreen === "home")
      ) {
        const spoken =
          "You are already on the Home screen. There is nowhere to go back.";
        await speechService.speak(spoken, { force: true });
        return spoken;
      }

      // Determine previous screen's conversational name
      let destinationName = "the previous screen";
      if (
        typeof backResult === "string" &&
        SCREEN_REGISTRY[backResult as AppScreen]
      ) {
        destinationName = SCREEN_REGISTRY[backResult as AppScreen].screenName;
      } else if (context.screenHistory && context.screenHistory.length > 0) {
        const prev = context.screenHistory[context.screenHistory.length - 1];
        if (SCREEN_REGISTRY[prev]) {
          destinationName = SCREEN_REGISTRY[prev].screenName;
        }
      } else if (currentScreen !== "home") {
        destinationName = "Home";
      }

      const spoken = `Returning to ${destinationName}.`;
      await speechService.speak(spoken, { force: true });
      return spoken;
    }

    case "next_class": {
      const next = await readingPipeline.queryNextClass();
      return next.spokenDescription;
    }

    case "read_this": {
      const mode = parsed.readingMode || "auto";
      const modeName =
        mode === "timetable"
          ? "timetable"
          : mode === "sign"
          ? "room sign"
          : mode === "notice"
          ? "notice"
          : "general text";
      const spoken = `Opening camera in ${modeName} reading mode.`;
      await speechService.speak(spoken, { force: true });
      const validMode: "auto" | "timetable" | "sign" | "notice" =
        mode === "timetable" || mode === "sign" || mode === "notice"
          ? mode
          : "auto";
      if (context.onNavigateToReader) {
        context.onNavigateToReader(validMode);
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("reader");
      }
      return spoken;
    }

    case "navigate_to": {
      const dest = parsed.destinationQuery || "";
      if (currentScreen === "navigation" && context.onMapSearchDestination) {
        if (!dest) {
          const promptMsg = "Where would you like to go? You can say a campus building, room, or landmark.";
          await speechService.speak(promptMsg, { force: true });
          return promptMsg;
        }
        await context.onMapSearchDestination(dest);
        return `Searching route to ${dest}.`;
      }
      const spoken = `Searching campus routes to ${dest || "destination"}.`;
      await speechService.speak(spoken, { force: true });
      if (context.onNavigateToNavigation) {
        context.onNavigateToNavigation(dest);
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("navigation");
      }
      return spoken;
    }


    case "find_object": {
      const target = parsed.targetObject || "keys";
      if (currentScreen !== "assist") {
        await speechService.speak(
          `Opening Scene Understanding to search for ${target}.`,
          { force: true }
        );
        if (context.onNavigateToAssist) {
          context.onNavigateToAssist();
        } else if (context.onNavigateToScreen) {
          context.onNavigateToScreen("assist");
        }
      }
      return await liveAssistService.searchTargetObject(target);
    }

    case "what_changed": {
      if (currentScreen !== "assist") {
        await speechService.speak("Opening Scene Understanding.", { force: true });
        if (context.onNavigateToAssist) {
          context.onNavigateToAssist();
        } else if (context.onNavigateToScreen) {
          context.onNavigateToScreen("assist");
        }
      }
      return await liveAssistService.whatChanged();
    }

    case "describe_again": {
      if (currentScreen !== "assist") {
        await speechService.speak("Opening Scene Understanding.", { force: true });
        if (context.onNavigateToAssist) {
          context.onNavigateToAssist();
        } else if (context.onNavigateToScreen) {
          context.onNavigateToScreen("assist");
        }
      }
      return await liveAssistService.describeNow();
    }

    case "what_is_ahead": {
      if (currentScreen === "assist") {
        return await liveAssistService.describeNow();
      }
      const desc = "Opening Saarthi Scene Understanding.";
      await speechService.speak(desc, { force: true });
      if (context.onNavigateToAssist) {
        context.onNavigateToAssist();
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("assist");
      } else if (context.onNavigateToReader) {
        context.onNavigateToReader("auto");
      }
      return desc;
    }

    case "unknown":
    default: {
      if (currentScreen === "assist" && parsed.rawTranscript && parsed.rawTranscript.trim()) {
        console.log(`[DIAGNOSTIC VOICE] Forwarding spoken query on assist screen to Gemini Live: "${parsed.rawTranscript.trim()}"`);
        return await liveAssistService.describeNow(parsed.rawTranscript.trim());
      }
      const msg = `I did not recognize the command "${parsed.rawTranscript}". Try asking "Where am I?", "What can I do here?", "Go Home", or "Open Reader".`;
      await speechService.speak(msg, { force: true });
      return msg;
    }
  }
}
