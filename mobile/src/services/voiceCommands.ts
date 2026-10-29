import type { AppScreen } from "../../App";

/**
 * Saarthi Deterministic Voice Intent Classifier.
 *
 * Implements deterministic intent parsing for spoken university commands.
 * Rule 3: Models EXTRACT; plain code REASONS.
 */

export type NavigationIntentType =
  | "open_home"
  | "open_reader"
  | "open_results"
  | "open_timetable"
  | "open_navigation"
  | "open_voice"
  | "open_settings"
  | "open_assist";

export type VoiceIntentType =
  | "read_this"
  | "scan_now"
  | "read_full_text"
  | "summarize_this"
  | "scan_again"
  | "what_is_ahead"
  | "find_object"
  | "what_changed"
  | "describe_again"
  | "where_am_i"
  | "what_can_i_do"
  | "next_class"
  | "navigate_to"
  | "stop_navigation"
  | "recenter_map"
  | "nearby_places"
  | "navigation_status"
  | NavigationIntentType
  | "go_back"
  | "repeat"
  | "stop"
  | "stop_listening"
  | "resume_listening"
  | "exit_voice_mode"
  | "unknown";


export const SCREEN_INTENT_MAP: Record<NavigationIntentType, AppScreen> = {
  open_home: "home",
  open_reader: "reader",
  open_results: "results",
  open_timetable: "timetable",
  open_navigation: "navigation",
  open_voice: "voice",
  open_settings: "settings",
  open_assist: "assist",
};

export interface ParsedVoiceCommand {
  intent: VoiceIntentType;
  rawTranscript: string;
  targetScreen?: AppScreen;
  destinationQuery?: string;
  categoryQuery?: string;
  targetObject?: string;
  readingMode?: "auto" | "timetable" | "sign" | "notice" | "surroundings";
  confidence: number;
}


/**
 * Clean a voice transcript for normalized matching.
 */
function cleanTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, "") // Normalize "what's" -> "whats", "where's" -> "wheres"
    .replace(/[.,?!:;'"-]/g, " ")
    .replace(/\btime\s+table\b/g, "timetable") // Normalize "time table" -> "timetable"
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classifies a user's speech transcript into one of the supported campus intents.
 */
export function parseVoiceCommand(transcript: string): ParsedVoiceCommand {
  const cleaned = cleanTranscript(transcript);

  if (!cleaned) {
    return { intent: "unknown", rawTranscript: transcript, confidence: 0 };
  }

  // 0a. EXIT VOICE MODE intent
  if (
    cleaned === "exit voice mode" ||
    cleaned === "turn off voice mode" ||
    cleaned === "disable voice mode" ||
    cleaned === "quit voice mode" ||
    cleaned === "close voice mode" ||
    cleaned === "turn off voice" ||
    cleaned === "stop voice mode"
  ) {
    return { intent: "exit_voice_mode", rawTranscript: transcript, confidence: 1.0 };
  }

  // 0b. STOP / PAUSE LISTENING intent
  if (
    cleaned === "stop listening" ||
    cleaned === "pause listening" ||
    cleaned === "pause voice" ||
    cleaned === "pause voice mode" ||
    cleaned === "mute microphone" ||
    cleaned === "mute mic"
  ) {
    return { intent: "stop_listening", rawTranscript: transcript, confidence: 1.0 };
  }

  // 0c. RESUME LISTENING intent
  if (
    cleaned === "resume listening" ||
    cleaned === "start listening" ||
    cleaned === "continue listening" ||
    cleaned === "unpause listening" ||
    cleaned === "resume voice"
  ) {
    return { intent: "resume_listening", rawTranscript: transcript, confidence: 1.0 };
  }

  // 0d. STOP NAVIGATION intent
  if (
    cleaned === "stop navigation" ||
    cleaned === "cancel navigation" ||
    cleaned === "end navigation" ||
    cleaned === "quit navigation" ||
    cleaned === "stop navigating" ||
    cleaned === "finish navigation"
  ) {
    return { intent: "stop_navigation", rawTranscript: transcript, confidence: 1.0 };
  }

  // 0e. RECENTER MAP intent
  if (
    cleaned === "recenter" ||
    cleaned === "recenter map" ||
    cleaned === "center map" ||
    cleaned === "go back to my current location" ||
    cleaned === "go back to my location" ||
    cleaned === "back to my location" ||
    cleaned === "re center" ||
    cleaned === "re center map"
  ) {
    return { intent: "recenter_map", rawTranscript: transcript, confidence: 0.98 };
  }

  // 0f. NAVIGATION STATUS / DISTANCE REMAINING intent
  if (
    cleaned === "how far is my destination" ||
    cleaned === "how far to destination" ||
    cleaned === "how far is the destination" ||
    cleaned === "how far is destination" ||
    cleaned === "distance remaining" ||
    cleaned === "how far" ||
    cleaned === "remaining distance" ||
    cleaned === "how much further"
  ) {
    return { intent: "navigation_status", rawTranscript: transcript, confidence: 0.98 };
  }

  // 1. STOP intent (immediate priority)
  if (
    cleaned === "stop" ||
    cleaned === "cancel" ||
    cleaned === "quiet" ||
    cleaned === "be quiet" ||
    cleaned === "shut up" ||
    cleaned === "hush" ||
    cleaned === "silence" ||
    cleaned.startsWith("stop speaking") ||
    cleaned.startsWith("stop reading") ||
    cleaned.startsWith("stop talking")
  ) {
    return { intent: "stop", rawTranscript: transcript, confidence: 1.0 };
  }


  // 2. REPEAT intent
  if (
    cleaned === "repeat" ||
    cleaned === "again" ||
    cleaned === "say again" ||
    cleaned === "say that again" ||
    cleaned === "repeat that" ||
    cleaned === "repeat this" ||
    cleaned === "repeat instruction" ||
    cleaned === "what did you say" ||
    cleaned === "pardon" ||
    cleaned === "one more time" ||
    cleaned.startsWith("repeat that") ||
    cleaned.startsWith("say that again") ||
    cleaned.startsWith("say again") ||
    cleaned.startsWith("repeat this") ||
    cleaned.startsWith("repeat instruction")
  ) {
    return { intent: "repeat", rawTranscript: transcript, confidence: 1.0 };
  }

  // 2a. SCAN NOW / CAPTURE intent (Voice-First Auto Read)
  if (
    cleaned === "scan now" ||
    cleaned === "capture" ||
    cleaned === "capture now" ||
    cleaned === "take photo" ||
    cleaned === "take picture" ||
    cleaned === "take a photo" ||
    cleaned === "take a picture" ||
    cleaned === "snap photo" ||
    cleaned === "snap picture" ||
    cleaned === "start scan" ||
    cleaned === "take scan" ||
    cleaned === "take a scan" ||
    cleaned === "scan this" ||
    cleaned === "scan image" ||
    cleaned === "capture photo" ||
    cleaned === "capture picture" ||
    cleaned === "shoot photo" ||
    cleaned === "scan document" ||
    cleaned === "scan page" ||
    cleaned === "scan please" ||
    cleaned.startsWith("scan now") ||
    cleaned.startsWith("take photo") ||
    cleaned.startsWith("take picture")
  ) {
    return { intent: "scan_now", rawTranscript: transcript, confidence: 0.98 };
  }

  // 2b. READ FULL TEXT intent (Voice-Controlled Results)
  if (
    cleaned === "read the full text" ||
    cleaned === "read full text" ||
    cleaned === "full text" ||
    cleaned === "read all text" ||
    cleaned === "read all" ||
    cleaned === "read entire text" ||
    cleaned === "read source text" ||
    cleaned === "source text" ||
    cleaned === "read verbatim" ||
    cleaned === "read everything" ||
    cleaned === "read out full text" ||
    cleaned === "read complete text" ||
    cleaned === "read the text" ||
    cleaned.startsWith("read the full text") ||
    cleaned.startsWith("read full text")
  ) {
    return { intent: "read_full_text", rawTranscript: transcript, confidence: 0.98 };
  }

  // 2c. SUMMARIZE THIS intent (Voice-Controlled Results)
  if (
    !cleaned.includes("notice") &&
    (cleaned === "summarize this" ||
      cleaned === "summarize" ||
      cleaned === "summary" ||
      cleaned === "read summary" ||
      cleaned === "give summary" ||
      cleaned === "give me a summary" ||
      cleaned === "brief summary" ||
      cleaned === "short summary" ||
      cleaned === "what does it say" ||
      cleaned === "what does this say" ||
      cleaned === "summarize result" ||
      cleaned === "summarize scan" ||
      cleaned === "read the summary" ||
      cleaned.includes("summarize this") ||
      cleaned.startsWith("summarize"))
  ) {
    return { intent: "summarize_this", rawTranscript: transcript, confidence: 0.98 };
  }

  // 2d. SCAN AGAIN intent (Voice-Controlled Results)
  if (
    cleaned === "scan again" ||
    cleaned === "scan another" ||
    cleaned === "scan another one" ||
    cleaned === "new scan" ||
    cleaned === "take another scan" ||
    cleaned === "take another photo" ||
    cleaned === "take another picture" ||
    cleaned === "rescan" ||
    cleaned === "re scan" ||
    cleaned === "another scan" ||
    cleaned === "scan once more" ||
    cleaned === "start another scan" ||
    cleaned.startsWith("scan again") ||
    cleaned.startsWith("scan another")
  ) {
    return { intent: "scan_again", rawTranscript: transcript, confidence: 0.98 };
  }

  // 3. GO BACK intent (Phase 2 navigation)
  if (
    cleaned === "go back" ||
    cleaned === "back" ||
    cleaned === "previous screen" ||
    cleaned === "return" ||
    cleaned === "go to previous screen" ||
    cleaned === "take me back" ||
    cleaned === "back screen" ||
    cleaned === "navigate back" ||
    cleaned === "back please"
  ) {
    return { intent: "go_back", rawTranscript: transcript, confidence: 0.98 };
  }

  // 4. WHERE AM I intent (Screen Awareness)
  if (
    cleaned === "where am i" ||
    cleaned === "where am i now" ||
    cleaned === "what screen is this" ||
    cleaned === "what screen am i on" ||
    cleaned === "which screen is this" ||
    cleaned === "which screen am i on" ||
    cleaned === "what is this screen" ||
    cleaned === "tell me what screen i am on" ||
    cleaned === "current screen" ||
    cleaned === "what room is this" ||
    cleaned === "which room is this" ||
    cleaned === "location" ||
    cleaned === "my location" ||
    cleaned === "what is that road called" ||
    cleaned === "what road is that" ||
    cleaned === "what road is this" ||
    cleaned === "what is this road" ||
    cleaned === "where am i right now" ||
    cleaned.includes("where am i") ||
    cleaned.includes("what screen am i on") ||
    cleaned.includes("what screen is this")
  ) {
    return { intent: "where_am_i", rawTranscript: transcript, confidence: 0.98 };
  }

  // 5. WHAT CAN I DO / HELP intent (Screen Awareness)
  if (
    cleaned === "what can i do here" ||
    cleaned === "what can i do" ||
    cleaned === "what can i do on this screen" ||
    cleaned === "what are my options" ||
    cleaned === "what are the options" ||
    cleaned === "what can i say" ||
    cleaned === "what are the commands" ||
    cleaned === "commands" ||
    cleaned === "show commands" ||
    cleaned === "list commands" ||
    cleaned === "help" ||
    cleaned === "help me" ||
    cleaned === "how does this work" ||
    cleaned === "instructions" ||
    cleaned.includes("what can i do here") ||
    cleaned.includes("what can i do")
  ) {
    return { intent: "what_can_i_do", rawTranscript: transcript, confidence: 0.98 };
  }

  // 6. GLOBAL SCREEN NAVIGATION INTENTS (Phase 2)
  // 6a. OPEN HOME
  if (
    cleaned === "open home" ||
    cleaned === "go home" ||
    cleaned === "return home" ||
    cleaned === "home" ||
    cleaned === "home screen" ||
    cleaned === "main menu" ||
    cleaned === "open main menu" ||
    cleaned === "go to home" ||
    cleaned === "go to home screen" ||
    cleaned === "take me home" ||
    cleaned === "return to home" ||
    cleaned === "return to home screen"
  ) {
    return {
      intent: "open_home",
      rawTranscript: transcript,
      targetScreen: "home",
      confidence: 0.98,
    };
  }

  // 6b. OPEN CAMPUS READER / SCAN / READ ANYTHING
  if (
    cleaned === "read anything" ||
    cleaned === "open read anything" ||
    cleaned === "read text" ||
    cleaned === "read campus text" ||
    cleaned === "open campus reader" ||
    cleaned === "open reader" ||
    cleaned === "campus reader" ||
    cleaned === "reader" ||
    cleaned === "reader screen" ||
    cleaned === "scan" ||
    cleaned === "start scanning" ||
    cleaned === "open scanner" ||
    cleaned === "go to reader" ||
    cleaned === "go to campus reader" ||
    cleaned === "take me to reader"
  ) {
    return {
      intent: "open_reader",
      rawTranscript: transcript,
      targetScreen: "reader",
      confidence: 0.98,
    };
  }

  // 6c. OPEN RESULTS
  if (
    cleaned === "open results" ||
    cleaned === "show results" ||
    cleaned === "results" ||
    cleaned === "reading results" ||
    cleaned === "open reading results" ||
    cleaned === "show reading results" ||
    cleaned === "view results" ||
    cleaned === "go to results" ||
    cleaned === "open result" ||
    cleaned === "show result"
  ) {
    return {
      intent: "open_results",
      rawTranscript: transcript,
      targetScreen: "results",
      confidence: 0.98,
    };
  }

  // 6d. OPEN TIMETABLE / MY DAY
  if (
    cleaned === "my day" ||
    cleaned === "open my day" ||
    cleaned === "show my day" ||
    cleaned === "open timetable" ||
    cleaned === "open time table" ||
    cleaned === "open my timetable" ||
    cleaned === "open my time table" ||
    cleaned === "show timetable" ||
    cleaned === "show time table" ||
    cleaned === "show my timetable" ||
    cleaned === "show my time table" ||
    cleaned === "open class timetable" ||
    cleaned === "open class time table" ||
    cleaned === "class timetable" ||
    cleaned === "class time table" ||
    cleaned === "my schedule" ||
    cleaned === "open schedule" ||
    cleaned === "show schedule" ||
    cleaned === "open my schedule" ||
    cleaned === "show my schedule" ||
    cleaned === "view timetable" ||
    cleaned === "view time table" ||
    cleaned === "my timetable" ||
    cleaned === "my time table" ||
    cleaned === "go to timetable" ||
    cleaned === "go to time table" ||
    cleaned === "timetable" ||
    cleaned === "time table" ||
    cleaned === "schedule"
  ) {
    return {
      intent: "open_timetable",
      rawTranscript: transcript,
      targetScreen: "timetable",
      confidence: 0.98,
    };
  }

  // 6e. OPEN NAVIGATION / CAMPUS MAP
  if (
    cleaned === "campus map" ||
    cleaned === "open campus map" ||
    cleaned === "map" ||
    cleaned === "show map" ||
    cleaned === "open map" ||
    cleaned === "open navigation" ||
    cleaned === "navigate" ||
    cleaned === "find a room" ||
    cleaned === "find room" ||
    cleaned === "campus navigation" ||
    cleaned === "open campus navigation" ||
    cleaned === "navigation" ||
    cleaned === "navigation screen" ||
    cleaned === "go to navigation" ||
    cleaned === "show navigation" ||
    cleaned === "find a classroom" ||
    cleaned === "find classroom"
  ) {
    return {
      intent: "open_navigation",
      rawTranscript: transcript,
      targetScreen: "navigation",
      confidence: 0.98,
    };
  }

  // 6f. OPEN VOICE ASSISTANT / TALK TO SAARTHI
  if (
    cleaned === "talk to saarthi" ||
    cleaned === "open talk to saarthi" ||
    cleaned === "open voice assistant" ||
    cleaned === "open voice" ||
    cleaned === "voice help" ||
    cleaned === "voice assistant" ||
    cleaned === "voice" ||
    cleaned === "open assistant" ||
    cleaned === "go to voice assistant" ||
    cleaned === "show voice assistant" ||
    cleaned === "voice screen"
  ) {
    return {
      intent: "open_voice",
      rawTranscript: transcript,
      targetScreen: "voice",
      confidence: 0.98,
    };
  }

  // 6g. OPEN SETTINGS / CHANGE SETTINGS
  if (
    cleaned === "open settings" ||
    cleaned === "change settings" ||
    cleaned === "settings" ||
    cleaned === "settings screen" ||
    cleaned === "open configuration" ||
    cleaned === "go to settings" ||
    cleaned === "preferences" ||
    cleaned === "open preferences"
  ) {
    return {
      intent: "open_settings",
      rawTranscript: transcript,
      targetScreen: "settings",
      confidence: 0.98,
    };
  }

  // 6h. OPEN LIVE CAMERA ASSIST / SCENE UNDERSTANDING
  if (
    cleaned === "open live assist" ||
    cleaned === "open camera assist" ||
    cleaned === "live assist" ||
    cleaned === "camera assist" ||
    cleaned === "start live assist" ||
    cleaned === "start camera assist" ||
    cleaned === "live camera assist" ||
    cleaned === "open live camera assist" ||
    cleaned === "open assist" ||
    cleaned === "assist" ||
    cleaned === "go to live assist" ||
    cleaned === "go to camera assist" ||
    cleaned === "open scene understanding" ||
    cleaned === "start scene understanding" ||
    cleaned === "scene understanding" ||
    cleaned === "turn on scene understanding"
  ) {
    return {
      intent: "open_assist",
      rawTranscript: transcript,
      targetScreen: "assist",
      confidence: 0.98,
    };
  }

  // 6i. WHAT CHANGED intent
  if (
    cleaned === "what changed" ||
    cleaned === "what has changed" ||
    cleaned === "did anything change" ||
    cleaned.includes("what changed")
  ) {
    return {
      intent: "what_changed",
      rawTranscript: transcript,
      confidence: 0.98,
    };
  }

  // 6j. DESCRIBE AGAIN intent
  if (
    cleaned === "describe again" ||
    cleaned === "describe scene again" ||
    cleaned === "re describe" ||
    cleaned === "describe once more"
  ) {
    return {
      intent: "describe_again",
      rawTranscript: transcript,
      confidence: 0.98,
    };
  }

  // 6k. TARGETED OBJECT SEARCH intent ("Where are my keys?")
  const findObjectPatterns = [
    /^where (?:are|is) (?:my|the|a)?\s*(.+)$/,
    /^find (?:my|the|a)?\s*(.+)$/,
    /^can you see (?:my|the|a)?\s*(.+)$/,
    /^do you see (?:my|the|a)?\s*(.+)$/,
    /^look for (?:my|the|a)?\s*(.+)$/,
  ];
  for (const pattern of findObjectPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const obj = match[1].trim();
      if (
        obj.length >= 2 &&
        !cleaned.includes("nearby") &&
        !cleaned.includes("nearest") &&
        !obj.startsWith("next class") &&
        !obj.startsWith("i am") &&
        !obj.startsWith("i") &&
        !obj.startsWith("campus") &&
        !obj.startsWith("to the") &&
        !obj.startsWith("to ")
      ) {
        return {
          intent: "find_object",
          rawTranscript: transcript,
          targetObject: obj,
          confidence: 0.98,
        };
      }
    }
  }

  // 7. READ THE TIMETABLE intent (specific scanner mode)
  if (
    cleaned === "read the timetable" ||
    cleaned === "read timetable" ||
    cleaned === "scan timetable" ||
    cleaned.includes("read timetable") ||
    cleaned.includes("read the timetable")
  ) {
    return {
      intent: "read_this",
      rawTranscript: transcript,
      readingMode: "timetable",
      confidence: 0.98,
    };
  }

  // 8. READ THIS ROOM NUMBER intent (specific scanner mode)
  if (
    cleaned === "read this room number" ||
    cleaned === "read room number" ||
    cleaned === "read room" ||
    cleaned === "read the sign" ||
    cleaned === "read door sign" ||
    cleaned.includes("room number") ||
    cleaned === "read sign"
  ) {
    return {
      intent: "read_this",
      rawTranscript: transcript,
      readingMode: "sign",
      confidence: 0.98,
    };
  }

  // 9. SUMMARIZE THIS NOTICE intent (specific scanner mode)
  if (
    cleaned === "summarize this notice" ||
    cleaned === "summarize notice" ||
    cleaned === "read notice" ||
    cleaned === "read the notice" ||
    cleaned === "read noticeboard" ||
    cleaned.includes("summarize this notice") ||
    cleaned.includes("summarize notice") ||
    cleaned === "noticeboard"
  ) {
    return {
      intent: "read_this",
      rawTranscript: transcript,
      readingMode: "notice",
      confidence: 0.98,
    };
  }

  // 10. GENERAL READ THIS intent
  if (
    cleaned === "read this" ||
    cleaned === "read text" ||
    cleaned.startsWith("read this") ||
    cleaned.startsWith("read the") ||
    cleaned === "scan text" ||
    cleaned === "ocr"
  ) {
    return {
      intent: "read_this",
      rawTranscript: transcript,
      readingMode: "auto",
      confidence: 0.95,
    };
  }

  // 11. WHAT IS AHEAD intent
  if (
    cleaned === "what is ahead" ||
    cleaned === "whats ahead" ||
    cleaned === "what is in front of me" ||
    cleaned === "what is in front" ||
    cleaned === "describe scene" ||
    cleaned === "what do you see" ||
    cleaned.includes("what do you see") ||
    cleaned === "describe" ||
    cleaned === "describe surroundings" ||
    cleaned === "describe my surroundings" ||
    cleaned.includes("describe surroundings") ||
    cleaned.includes("what is ahead") ||
    cleaned.includes("whats ahead")
  ) {
    return { intent: "what_is_ahead", rawTranscript: transcript, confidence: 0.95 };
  }

  // 12. WHEN IS MY NEXT CLASS intent
  if (
    cleaned === "when is my next class" ||
    cleaned === "next class" ||
    cleaned === "my next class" ||
    cleaned === "what is my next class" ||
    cleaned === "where is my next class" ||
    cleaned === "what class is next" ||
    cleaned.includes("next class")
  ) {
    return { intent: "next_class", rawTranscript: transcript, confidence: 0.95 };
  }

  // 12b. TAKE ME SOMEWHERE ELSE intent
  if (
    cleaned === "take me somewhere else" ||
    cleaned === "navigate somewhere else" ||
    cleaned === "go somewhere else" ||
    cleaned === "choose another destination" ||
    cleaned === "different destination"
  ) {
    return {
      intent: "navigate_to",
      rawTranscript: transcript,
      destinationQuery: "",
      confidence: 0.95,
    };
  }

  // 12c. NEARBY PLACES / SURROUNDINGS AMENITIES intent
  if (
    cleaned === "what places are near me" ||
    cleaned === "what is near me" ||
    cleaned === "what is around me" ||
    cleaned === "nearby places" ||
    cleaned === "places nearby" ||
    cleaned === "what is nearby"
  ) {
    return {
      intent: "nearby_places",
      rawTranscript: transcript,
      categoryQuery: "general",
      confidence: 0.95,
    };
  }

  const nearbyPatterns = [
    /^find (?:a )?(.+) nearby$/,
    /^find nearby (.+)$/,
    /^where is the nearest (.+)$/,
    /^where is nearest (.+)$/,
    /^nearest (.+)$/,
    /^search (?:for )?(.+) nearby$/,
  ];

  for (const pattern of nearbyPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const cat = match[1].trim();
      if (cat.length >= 2) {
        return {
          intent: "nearby_places",
          rawTranscript: transcript,
          categoryQuery: cat,
          confidence: 0.95,
        };
      }
    }
  }

  // 13. TAKE ME TO <PLACE> intent (with destination query)
  const navPatterns = [
    /^take me to (?:the )?(.+)$/,
    /^navigate to (?:the )?(.+)$/,
    /^directions to (?:the )?(.+)$/,
    /^how do i get to (?:the )?(.+)$/,
    /^where is (?:the )?(.+)$/,
    /^guide me to (?:the )?(.+)$/,
    /^find (?:the )?(.+)$/,
  ];


  for (const pattern of navPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const dest = match[1].trim();
      if (dest.length >= 2) {
        return {
          intent: "navigate_to",
          rawTranscript: transcript,
          destinationQuery: dest,
          confidence: 0.95,
        };
      }
    }
  }

  return {
    intent: "unknown",
    rawTranscript: transcript,
    confidence: 0.3,
  };
}
