import { useEffect, useState } from "react";
import { Rnd } from "react-rnd";
import { LayoutGrid } from "lucide-react";
import { DisplayVideo } from "../app/types/displayVideo";
import { Position } from "../app/types/positionType";

// Pick the (cols, rows) that minimizes aspect mismatch between cells and the
// expected video aspect (16:9 default).
function pickGrid(n: number, w: number, h: number, vAspect = 16 / 9): [number, number] {
  if (n <= 1) return [1, Math.max(1, n)];
  // n=2 has a canonical answer: side-by-side on landscape, stacked on portrait.
  // The aspect-based optimization below flips between (2,1) and (1,2) for
  // similar containers, which made host and participant disagree (host has
  // a sidebar → narrower stage → stacked; participant → side-by-side).
  // Forcing consistency here matches the visual convention of "two people
  // facing each other" and what every video-conf app does.
  if (n === 2) return w >= h ? [2, 1] : [1, 2];
  if (w <= 0 || h <= 0) {
    const cols = Math.ceil(Math.sqrt(n));
    return [cols, Math.ceil(n / cols)];
  }
  let best: [number, number] = [1, n];
  let bestScore = Infinity;
  let bestCellAspect = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = (w / cols) / (h / rows);
    const dist = Math.abs(Math.log(cellAspect / vAspect));
    const empties = cols * rows - n;
    const score = dist + empties * 0.08;
    const better =
      score < bestScore ||
      (score === bestScore && cellAspect > bestCellAspect);
    if (better) {
      bestScore = score;
      bestCellAspect = cellAspect;
      best = [cols, rows];
    }
  }
  return best;
}

type MainStageProps = {
  displayVideos: DisplayVideo[];
  layout?: "grid" | "custom" | "pin";
  pinnedVideo?: string | null;
  customPositions?: Record<string, Position>;
  updatePosition?: (
    key: string,
    x: number,
    y: number,
    width?: number,
    height?: number,
    z?: number
  ) => void;
  onPinVideo?: (key: string) => void;
  onGoToGrid?: () => void;
  className?: string;
  // Role-aware empty state. Default = host (legacy callers): the host sees
  // an actionable hint ("add from sidebar"). Pass `isHost={false}` from the
  // participant tree so the message reads as "waiting for the host" instead
  // — participants can't add anyone to the stage.
  isHost?: boolean;
};

export default function MainStage({
  displayVideos,
  layout = "grid",
  customPositions = {},
  updatePosition,
  pinnedVideo,
  onPinVideo,
  onGoToGrid,
  className = "",
  isHost = true,
}: MainStageProps) {
  const audioElements = [];

  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  
  useEffect(() => {
    if (!gridEl) return;
    const update = () => setGridSize({ w: gridEl.clientWidth, h: gridEl.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(gridEl);
    return () => ro.disconnect();
  }, [gridEl]);

  if (displayVideos.length === 0)
    return (
      <div className={`flex flex-col items-center justify-center w-full h-full bg-zinc-900 ${className}`}>
        <svg className="w-16 h-16 text-zinc-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
        </svg>
        <p className="text-zinc-500 text-sm font-medium">
          {isHost ? "No participants on stage" : "Waiting for the host"}
        </p>
        <p className="text-zinc-600 text-xs mt-1">
          {isHost
            ? "Add participants from the sidebar"
            : "The host will add people to the stage shortly"}
        </p>
      </div>
    );

  // ----------------- GRID LAYOUT (CORREGIDO) -----------------
  if (layout === "grid") {
    const n = displayVideos.length;
    const [cols, rows] = pickGrid(n, gridSize.w, gridSize.h);

    return (
      <div
        ref={setGridEl}
        className={`grid w-full h-full gap-4 p-2 place-items-center ${className}`}
        style={{
          backgroundColor: "#09090b",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {displayVideos.map((v) => (
          <div
            key={v.key}
            className="w-full h-full flex items-center justify-center overflow-hidden"
          >
            {/* Forzamos que el contenedor mantenga el ratio 16:9 de la cámara.
              Añadimos clases específicas para que afecten directamente al <video> interno de LiveKit
            */}
            <div
              className="relative w-full h-full aspect-video max-w-full max-h-full bg-black rounded-md overflow-hidden shadow-md
                         flex items-center justify-center
                         [&_video]:!w-full [&_video]:!h-full [&_video]:!object-contain [&_video]:!position-relative"
            >
              {v.component}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ----------------- PIN LAYOUT (CORREGIDO) -----------------
  if (layout === "pin") {
    const _pinnedVideo = displayVideos.filter(v => pinnedVideo == v.key);
    const others = displayVideos.filter(v => pinnedVideo !== v.key);
    
    return (
      <div className="relative w-full h-full flex items-center justify-center p-4" style={{ backgroundColor: "#09090b" }}>
        {/* Pinned Video Grande - Ahora con contain-fit estricto */}
        {_pinnedVideo && _pinnedVideo[0] && (
          <div className="w-full h-full max-w-full max-h-full flex items-center justify-center p-2 pb-24">
            <div className="relative w-full h-full aspect-video max-w-full max-h-full bg-black rounded-lg overflow-hidden shadow-2xl
                            [&_video]:w-full [&_video]:h-full [&_video]:object-contain
                            [&_canvas]:w-full [&_canvas]:h-full">
              {_pinnedVideo[0].component}
            </div>
          </div>
        )}

        {/* Carrusel de Miniaturas */}
        <div className="absolute bottom-4 mb-safe left-1/2 transform -translate-x-1/2 flex items-center gap-3 z-50 bg-black/60 backdrop-blur-md p-3 rounded-xl border border-white/10 overflow-x-auto max-w-[90%] shadow-lg">
          {onGoToGrid && (
            <button
              onClick={onGoToGrid}
              title="Back to grid"
              className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg
                         bg-white/10 hover:bg-white/20 text-white transition-colors border border-white/5"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          )}
          {others.map((v) => (
            <div
              key={v.key}
              onClick={onPinVideo ? () => onPinVideo(v.key) : undefined}
              className={`flex-shrink-0 rounded-lg overflow-hidden border border-white/20 bg-zinc-950 aspect-video h-16 ${
                onPinVideo ? "cursor-pointer hover:border-blue-500 hover:scale-105 transition-all duration-200" : ""
              } [&_video]:w-full [&_video]:h-full [&_video]:object-cover [&_canvas]:w-full [&_canvas]:h-full`}
              title={onPinVideo ? "Click to pin this video" : undefined}
            >
              {v.component}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ----------------- CUSTOM LAYOUT -----------------
  if (layout === "custom") {
    return (
      <div className={`relative w-full h-full ${className}`} style={{ backgroundColor: "#09090b" }}>
        {displayVideos.map((v) => {
          const pos =
            customPositions[v.key] || {
              x: 0,
              y: 0,
              width: 200,
              height: 150,
              z: 10,
            };
          const zIndex = pos.z ?? 10;

          return (
            <Rnd
              key={v.key}
              size={{ width: pos.width, height: pos.height }}
              position={{ x: pos.x, y: pos.y }}
              bounds="parent"
              style={{ zIndex }}
              onDragStart={() => {
                const maxZ = Math.max(
                  ...Object.values(customPositions).map((p) => p.z ?? 10)
                );
                updatePosition &&
                  updatePosition(
                    v.key,
                    pos.x,
                    pos.y,
                    pos.width,
                    pos.height,
                    maxZ + 1
                  );
              }}
              onDragStop={(e, d) =>
                updatePosition &&
                updatePosition(v.key, d.x, d.y, pos.width, pos.height, pos.z)
              }
              onResizeStart={() => {
                const maxZ = Math.max(
                  ...Object.values(customPositions).map((p) => p.z ?? 10)
                );
                updatePosition &&
                  updatePosition(
                    v.key,
                    pos.x,
                    pos.y,
                    pos.width,
                    pos.height,
                    maxZ + 1
                  );
              }}
              onResizeStop={(e, dir, ref, delta, position) =>
                updatePosition &&
                updatePosition(
                  v.key,
                  position.x,
                  position.y,
                  ref.offsetWidth,
                  ref.offsetHeight,
                  pos.z
                )
              }
            >
              <div className="w-full h-full border bg-black overflow-hidden rounded [&_video]:w-full [&_video]:h-full [&_video]:object-contain">
                {v.component}
              </div>
            </Rnd>
          );
        })}
        <div id="findme" className="sr-only">{audioElements}</div>
      </div>
    );
  }

  return null;
}