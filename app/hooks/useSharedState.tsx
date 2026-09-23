import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRoomContext } from "@livekit/components-react";
import {
    STATE_TOPIC,
    applyJsonPatch,
    type SharedState,
    type JsonPatchOp,
    type AnyInboundMsg,
    type StateChangeMsg,
    type StateSnapshotMsg,
    type AudioMode,
} from "../types/sharedStateTypes";

export type EntityLayout = { x?: number; y?: number; w?: number; h?: number; z?: number };
export type EntityPlayback = { muted?: boolean; paused?: boolean; rate?: number };

export type SharedStateAPI = {
    state: SharedState | null;
    version: number;
    sending: boolean;
    sendChange: (patch: JsonPatchOp[], meta?: Record<string, unknown>) => Promise<"ok" | "refused">;
    setLayout: (layout: string, pinnedVideo?: string | null) => Promise<"ok" | "refused">;
    setAudioMode: (mode: AudioMode) => Promise<"ok" | "refused">;
    upsertEntity: (
        id: string,
        data: Partial<{ kind: string; visible: boolean; layout: EntityLayout; playback: EntityPlayback, trackSid: string, participantId: string }>
    ) => Promise<"ok" | "refused">;
    setEntityLayout: (id: string, layout: EntityLayout) => Promise<"ok" | "refused">;
    setEntityPlayback: (id: string, playback: EntityPlayback) => Promise<"ok" | "refused">;
    setMultiplePlayback: (changes: Record<string, EntityPlayback>) => Promise<"ok" | "refused">;
    setEntityVisible: (id: string, visible: boolean) => Promise<"ok" | "refused">;
    removeEntity: (id: string) => Promise<"ok" | "refused">;
};

const SharedStateContext = createContext<SharedStateAPI | null>(null);

export function useSharedStateContext(): SharedStateAPI {
    const ctx = useContext(SharedStateContext);
    if (!ctx) throw new Error("useSharedStateContext must be inside provider");
    return ctx;
}

export function SharedStateProvider({ children }: { children: React.ReactNode }) {
    const api = useSharedState();
    return <SharedStateContext.Provider value={api}>{children}</SharedStateContext.Provider>;
}

export function useSharedState(): SharedStateAPI {
    const room = useRoomContext();
    const [state, setState] = useState<SharedState | null>(null);
    const [sending, setSending] = useState(false);
    const versionRef = useRef(-1);
    const awaitingAck = useRef(false);

    const stateRef = useRef<SharedState | null>(null);
    // The ref must be written together with setState, not from an effect:
    // effects of child components run before this one's, so a consumer that
    // calls sendChange as soon as `state` first arrives would read a stale
    // null ref and get a spurious "refused".
    const applyState = (next: SharedState) => {
        stateRef.current = next;
        setState(next);
    };

    const pendingChanges = useRef<StateChangeMsg[]>([]);

    const askedRef = useRef(false);
    const snapshotAttempts = useRef(0);
    const snapshotTimer = useRef<number | null>(null);

    const MAX_SNAPSHOT_ATTEMPTS = 6;
    const SNAPSHOT_RETRY_MS = 1500;

    useEffect(() => {
        if (!room) return;

        const handler = (payload: Uint8Array, _p: any, _kind: number, topic?: string) => {
            if (topic !== STATE_TOPIC) return;
            let msg: AnyInboundMsg;
            try {
                msg = JSON.parse(new TextDecoder().decode(payload)) as AnyInboundMsg;
            } catch (e) {
                console.warn("sharedState: failed to parse dataReceived payload", e);
                return;
            }

            if (msg.type === "state/snapshot") {
                const s = (msg as StateSnapshotMsg).state;
                versionRef.current = s.version;
                awaitingAck.current = false;
                setSending(false);

                if (pendingChanges.current.length > 0) {
                    const sorted = pendingChanges.current.slice().sort((a, b) => a.toVersion - b.toVersion);
                    let nextState = s;
                    for (const change of sorted) {
                        if (change.toVersion > versionRef.current) {
                            nextState = applyJsonPatch(nextState, change.diff);
                            (nextState as any).version = change.toVersion;
                            versionRef.current = change.toVersion;
                        }
                    }
                    pendingChanges.current = [];
                    applyState(nextState);
                } else {
                    applyState(s);
                }

                askedRef.current = true;
                snapshotAttempts.current = 0;
                if (snapshotTimer.current) {
                    window.clearTimeout(snapshotTimer.current);
                    snapshotTimer.current = null;
                }

                return;
            }

            if (msg.type === "state/change") {
                const { toVersion, diff } = msg as StateChangeMsg;
                const cur = stateRef.current;
                if (!cur) {
                    const existingIndex = pendingChanges.current.findIndex((c) => c.toVersion === toVersion);
                    if (existingIndex >= 0) {
                        pendingChanges.current[existingIndex] = msg as StateChangeMsg;
                    } else {
                        pendingChanges.current.push(msg as StateChangeMsg);
                    }
                    return;
                }
                if (toVersion > versionRef.current) {
                    const next = applyJsonPatch(cur, diff);
                    (next as any).version = toVersion;
                    versionRef.current = toVersion;
                    applyState(next);
                    awaitingAck.current = false;
                    setSending(false);
                }
                return;
            }

            if (msg.type === "state/changeRefused") {
                awaitingAck.current = false;
                setSending(false);
                requestSnapshotRoom();
                return;
            }
        };

        room.on("dataReceived", handler);

        const sendSnapshotRequest = () => {
            if (askedRef.current && snapshotAttempts.current === 0) return;
            if (snapshotAttempts.current >= MAX_SNAPSHOT_ATTEMPTS) return;

            snapshotAttempts.current += 1;
            askedRef.current = true;

            room.localParticipant.publishData(
                new TextEncoder().encode(JSON.stringify({ type: "state/requestSnapshot" })),
                { reliable: true, topic: STATE_TOPIC }
            );

            if (snapshotTimer.current) {
                window.clearTimeout(snapshotTimer.current);
                snapshotTimer.current = null;
            }
            snapshotTimer.current = window.setTimeout(() => {
                if (!stateRef.current && snapshotAttempts.current < MAX_SNAPSHOT_ATTEMPTS) {
                    askedRef.current = false;
                    sendSnapshotRequest();
                }
            }, SNAPSHOT_RETRY_MS);
        };

        const requestSnapshotRoom = () => {
            if (stateRef.current) return;
            if (snapshotAttempts.current >= MAX_SNAPSHOT_ATTEMPTS) return;
            askedRef.current = false;
            sendSnapshotRequest();
        };

        const onConnected = () => {
            snapshotAttempts.current = 0;
            askedRef.current = false;
            sendSnapshotRequest();
        };

        room.on("connected", onConnected);

        if (room.state === "connected") {
            sendSnapshotRequest();
        }

        return () => {
            room.off("connected", onConnected);
            room.off("dataReceived", handler);
            if (snapshotTimer.current) {
                window.clearTimeout(snapshotTimer.current);
                snapshotTimer.current = null;
            }
        };
    }, [room]);

    const sendChange = useMemo(
        () => async (patch: JsonPatchOp[], meta?: Record<string, unknown>) => {
            if (!room || !stateRef.current || awaitingAck.current) return "refused";
            const msg = { type: "state/patch", baseVersion: versionRef.current, patch, meta };
            setSending(true);
            awaitingAck.current = true;
            room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), {
                reliable: true,
                topic: STATE_TOPIC,
            });
            return "ok";
        },
        [room]
    );

    const setLayout = useMemo(
        () => (layout: string, pinnedVideo?: string | null) =>
            sendChange(
                [
                    { op: "replace", path: "/ui/layout", value: layout },
                    { op: "add", path: "/ui/pinnedVideo", value: pinnedVideo ?? null },
                ],
                { reason: "layout change" }
            ),
        [sendChange]
    );

    const setAudioMode = useMemo(
        () => (mode: AudioMode) =>
            sendChange(
                [{ op: "add", path: "/ui/audioMode", value: mode }],
                { reason: "audio mode change" }
            ),
        [sendChange]
    );

    const upsertEntity = useMemo(
        () => (id: string, data: any) =>
            sendChange([{ op: "add", path: `/entities/${id}`, value: { ...(data ?? {}) } }], {
                reason: "upsert entity",
                id,
            }),
        [sendChange]
    );

    const setEntityLayout = useMemo(
        () => (id: string, layout: any) =>
            sendChange([{ op: "add", path: `/entities/${id}/layout`, value: { ...(layout ?? {}) } }], {
                reason: "set layout",
                id,
            }),
        [sendChange]
    );

    const setEntityPlayback = useMemo(
        () => (id: string, playback: any) =>
            sendChange([{ op: "add", path: `/entities/${id}/playback`, value: { ...(playback ?? {}) } }], {
                reason: "set playback",
                id,
            }),
        [sendChange]
    );

    const setMultiplePlayback = useMemo(
        () => (changes: Record<string, any>) => {
            const patches = Object.entries(changes).map(([id, playback]) => ({
                op: "add" as const,
                path: `/entities/${id}/playback`,
                value: { ...(playback ?? {}) }
            }));
            return sendChange(patches, { reason: "batch mute/unmute" });
        },
        [sendChange]
    );

    const setEntityVisible = useMemo(
        () => (id: string, visible: boolean) =>
            sendChange([{ op: "add", path: `/entities/${id}/visible`, value: !!visible }], {
                reason: "toggle visible",
                id,
            }),
        [sendChange]
    );

    const removeEntity = useMemo(
        () => (id: string) =>
            sendChange([{ op: "remove", path: `/entities/${id}` }], { reason: "remove entity", id }),
        [sendChange]
    );

    // ✅ useMemo estabiliza el objeto retornado — solo cambia cuando state o sending cambian de verdad
    return useMemo(() => ({
        state,
        version: state ? state.version : -1,
        sending,
        sendChange,
        setLayout,
        setAudioMode,
        upsertEntity,
        setEntityLayout,
        setEntityPlayback,
        setMultiplePlayback,
        setEntityVisible,
        removeEntity,
    }), [
        state,
        sending,
        sendChange,
        setLayout,
        setAudioMode,
        upsertEntity,
        setEntityLayout,
        setEntityPlayback,
        setMultiplePlayback,
        setEntityVisible,
        removeEntity,
    ]);
}
