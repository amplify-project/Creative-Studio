export const STATE_TOPIC = "state" as const;

export type AudioMode = "music" | "speech";

export type SharedState = {
  version: number;
  ui: { layout: string; theme?: string; pinnedVideo?: string | null; audioMode?: AudioMode };
  entities: Record<
    string,
    {
      kind: string;
      visible?: boolean;
      playback?: { muted?: boolean; paused?: boolean; rate?: number };
      layout?: { x?: number; y?: number; w?: number; h?: number; z?: number };
      // The live track this tile is bound to, and the source it was published
      // from ("camera" | "screen_share" | ...). The source is what tells the
      // host's recovery pass, when the sid disappears, whether the entity may
      // be rebound to another of the participant's video tracks.
      trackSid?: string;
      source?: string;
      [k: string]: unknown;
      participantId:string;
    }
  >;
  meta: { updatedBy: string | null; timestamp: number | null };
};

export type StateSnapshotMsg = {
  type: "state/snapshot";
  state: SharedState;
};

export type StatePatchMsg = {
  type: "state/patch";
  baseVersion: number;
  patch: JsonPatchOp[];
  meta?: Record<string, unknown>;
};

export type StateChangeMsg = {
  type: "state/change";
  fromVersion: number;
  toVersion: number;
  diff: JsonPatchOp[];
  who: { identity: string; role?: string };
  ts: number;
};

export type StateChangeRefusedMsg = {
  type: "state/changeRefused";
  reason: "version_conflict" | "invalid_patch" | "forbidden";
  expectedBaseVersion?: number;
  currentVersion?: number;
  error?: string;
};

export type AnyInboundMsg =
  | StateSnapshotMsg
  | StateChangeMsg
  | StateChangeRefusedMsg;

export type JsonPatchOp =
  | { op: "replace" | "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

// Minimal, safe patch applier for replace/add/remove on simple JSON paths.
// Supports paths like "/ui/layout" or "/entities/vid123/visible".
export function applyJsonPatch<T extends object>(obj: T, ops: JsonPatchOp[]): T {
  const clone: any = structuredClone(obj);
  for (const op of ops) {
    const segs = op.path.replace(/^\//, "").split("/").filter(Boolean);
    if (segs.length === 0) throw new Error("empty path");
    let ref: any = clone;
    for (let i = 0; i < segs.length - 1; i++) {
      const key = segs[i];
      if (!(key in ref) || typeof ref[key] !== "object" || ref[key] === null) {
        // auto-create intermediate objects for "add"
        ref[key] = {};
      }
      ref = ref[key];
    }
    const leaf = segs[segs.length - 1];
    switch (op.op) {
      case "replace":
      case "add":
        ref[leaf] = (op as any).value;
        break;
      case "remove":
        if (Array.isArray(ref)) {
          const idx = Number(leaf);
          if (Number.isNaN(idx)) throw new Error("remove non-index on array");
          ref.splice(idx, 1);
        } else {
          delete ref[leaf];
        }
        break;
    }
  }
  return clone as T;
}
