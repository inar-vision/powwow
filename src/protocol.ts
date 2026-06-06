// Wire protocol shared (conceptually) between daemon and browser client.
// Kept deliberately small and JSON-friendly.

export type { AgentEvent } from "./agent-adapter";

export interface ParticipantInfo {
  id: string;
  name: string;
  isDriver: boolean;
  requestingControl: boolean;
}

export interface SuggestionInfo {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
}

// Messages sent from a client (browser) to the daemon.
export type ClientMessage =
  | { type: "hello"; name: string; clientId?: string } // clientId present on reconnect
  | { type: "input"; data: string } // keystrokes; honored only from the driver
  | { type: "resize"; cols: number; rows: number } // honored only from the driver
  | { type: "request_control" }
  | { type: "yield_control" }
  | { type: "suggest"; text: string } // post a prompt suggestion for the driver
  | { type: "accept_suggestion"; id: string } // driver: write suggestion to PTY
  | { type: "dismiss_suggestion"; id: string } // driver or poster: discard
  | { type: "typing" }; // I am typing (driver input or observer suggestion box)

// Messages sent from the daemon to a client.
export type ServerMessage =
  | {
      type: "init";
      youId: string;
      clientId: string; // stable identity token — store and send back on reconnect
      driverId: string | null;
      participants: ParticipantInfo[];
      cols: number;
      rows: number;
      suggestions: SuggestionInfo[];
    }
  | { type: "output"; data: string } // terminal bytes (utf-8)
  | { type: "resize"; cols: number; rows: number } // authoritative terminal size
  | {
      type: "presence";
      driverId: string | null;
      participants: ParticipantInfo[];
    }
  | { type: "notice"; text: string } // ephemeral status line, e.g. "Mara requested control"
  | { type: "suggestion"; suggestion: SuggestionInfo } // new suggestion posted
  | { type: "suggestion_cleared"; id: string } // suggestion sent or dismissed
  | { type: "typing"; id: string; name: string } // participant is typing
  | { type: "agent_event"; event: import("./agent-adapter").AgentEvent; historical?: boolean } // structured AI session event
  | { type: "session_reset" } // Claude started a new session — clear the feed
  | { type: "clipboard"; text: string } // serve mode: copy accepted suggestion to host clipboard
  | { type: "exit"; code: number | null }; // the wrapped agent process ended
