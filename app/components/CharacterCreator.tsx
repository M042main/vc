"use client";

import {
  Download,
  Eraser,
  Pencil,
  Redo2,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import styles from "./CharacterCreator.module.css";

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 760;
const MAX_HISTORY = 28;

type CharacterSide = "front" | "back";
type DrawingTool = "pencil" | "eraser";

type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type CharacterCreatorProps = {
  onSendToStudio?: (dataUrl: string) => void;
};

const PALETTE = [
  "#172032",
  "#FFFFFF",
  "#FF5C5C",
  "#FF9E45",
  "#FFD84A",
  "#55C98B",
  "#55A7FF",
  "#806DFF",
  "#E66EC7",
  "#9A684B",
] as const;

const BRUSH_SIZES = [
  { label: "얇게", value: 6 },
  { label: "보통", value: 14 },
  { label: "굵게", value: 28 },
] as const;

function createSilhouettePath() {
  const path = new Path2D();

  path.moveTo(300, 24);
  path.bezierCurveTo(342, 24, 371, 58, 371, 105);
  path.bezierCurveTo(371, 150, 354, 179, 328, 191);
  path.lineTo(328, 204);
  path.bezierCurveTo(348, 207, 365, 213, 379, 224);
  path.bezierCurveTo(398, 240, 408, 264, 414, 294);
  path.lineTo(439, 420);
  path.bezierCurveTo(443, 440, 433, 454, 418, 457);
  path.bezierCurveTo(403, 460, 392, 449, 389, 433);
  path.lineTo(366, 325);
  path.lineTo(368, 405);
  path.bezierCurveTo(369, 428, 375, 450, 382, 470);
  path.bezierCurveTo(393, 504, 394, 536, 392, 573);
  path.lineTo(390, 694);
  path.lineTo(419, 719);
  path.bezierCurveTo(431, 730, 425, 742, 411, 744);
  path.lineTo(351, 744);
  path.bezierCurveTo(340, 744, 335, 737, 335, 725);
  path.lineTo(329, 523);
  path.bezierCurveTo(327, 494, 319, 478, 300, 478);
  path.bezierCurveTo(281, 478, 273, 494, 271, 523);
  path.lineTo(265, 725);
  path.bezierCurveTo(265, 737, 260, 744, 249, 744);
  path.lineTo(189, 744);
  path.bezierCurveTo(175, 742, 169, 730, 181, 719);
  path.lineTo(210, 694);
  path.lineTo(208, 573);
  path.bezierCurveTo(206, 536, 207, 504, 218, 470);
  path.bezierCurveTo(225, 450, 231, 428, 232, 405);
  path.lineTo(234, 325);
  path.lineTo(211, 433);
  path.bezierCurveTo(208, 449, 197, 460, 182, 457);
  path.bezierCurveTo(167, 454, 157, 440, 161, 420);
  path.lineTo(186, 294);
  path.bezierCurveTo(192, 264, 202, 240, 221, 224);
  path.bezierCurveTo(235, 213, 252, 207, 272, 204);
  path.lineTo(272, 191);
  path.bezierCurveTo(246, 179, 229, 150, 229, 105);
  path.bezierCurveTo(229, 58, 258, 24, 300, 24);
  path.closePath();

  return path;
}

function drawWorkspace(context: CanvasRenderingContext2D) {
  const gradient = context.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
  gradient.addColorStop(0, "#F8F7F3");
  gradient.addColorStop(1, "#EFEEE9");
  context.fillStyle = gradient;
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  context.fillStyle = "rgba(78, 83, 92, 0.10)";
  for (let y = 20; y < CANVAS_HEIGHT; y += 24) {
    for (let x = 20; x < CANVAS_WIDTH; x += 24) {
      context.beginPath();
      context.arc(x, y, 1.1, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.save();
  context.fillStyle = "rgba(38, 42, 48, 0.07)";
  context.beginPath();
  context.ellipse(300, 736, 156, 13, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawGuide(context: CanvasRenderingContext2D, side: CharacterSide) {
  const silhouette = createSilhouettePath();

  context.save();
  context.strokeStyle = "rgba(53, 58, 66, 0.62)";
  context.lineWidth = 2.2;
  context.setLineDash([]);
  context.stroke(silhouette);
  context.clip(silhouette);

  context.strokeStyle = "rgba(58, 63, 73, 0.24)";
  context.lineWidth = 1.4;
  context.setLineDash([7, 8]);

  context.beginPath();
  context.moveTo(300, 37);
  context.lineTo(300, 705);
  context.stroke();

  context.beginPath();
  context.moveTo(226, 273);
  context.bezierCurveTo(268, 292, 332, 292, 374, 273);
  context.stroke();

  context.beginPath();
  context.moveTo(226, 445);
  context.bezierCurveTo(266, 430, 334, 430, 374, 445);
  context.stroke();

  context.setLineDash([]);
  if (side === "front") {
    context.beginPath();
    context.ellipse(300, 111, 58, 41, 0, 0.1 * Math.PI, 0.9 * Math.PI);
    context.stroke();

    context.beginPath();
    context.moveTo(260, 111);
    context.quadraticCurveTo(270, 104, 281, 111);
    context.moveTo(319, 111);
    context.quadraticCurveTo(330, 104, 340, 111);
    context.stroke();

    context.beginPath();
    context.moveTo(287, 146);
    context.quadraticCurveTo(300, 153, 313, 146);
    context.stroke();
  } else {
    context.beginPath();
    context.arc(300, 115, 58, 1.12 * Math.PI, 1.88 * Math.PI);
    context.stroke();

    context.beginPath();
    context.moveTo(254, 248);
    context.quadraticCurveTo(273, 231, 290, 250);
    context.moveTo(310, 250);
    context.quadraticCurveTo(327, 231, 346, 248);
    context.stroke();
  }

  const joints = [
    [202, 339],
    [398, 339],
    [236, 558],
    [364, 558],
  ];
  context.fillStyle = "rgba(58, 63, 73, 0.18)";
  for (const [x, y] of joints) {
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fill();
  }

  context.restore();
}

function drawStroke(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  tool: DrawingTool,
  color: string,
  brushSize: number,
) {
  const averagePressure = (from.pressure + to.pressure) / 2;
  const width = brushSize * (0.55 + averagePressure * 0.9);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);

  context.save();
  context.clip(createSilhouettePath());
  context.globalCompositeOperation =
    tool === "eraser" ? "destination-out" : "source-over";
  context.globalAlpha = tool === "eraser" ? 1 : 0.96;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = width;
  context.strokeStyle = color;
  context.fillStyle = color;

  if (distance < 0.15) {
    context.beginPath();
    context.arc(to.x, to.y, width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.quadraticCurveTo(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2,
      to.x,
      to.y,
    );
    context.stroke();
  }

  context.restore();
}

export function CharacterCreator({
  onSendToStudio,
}: CharacterCreatorProps) {
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingLayersRef = useRef<
    Partial<Record<CharacterSide, HTMLCanvasElement>>
  >({});
  const undoHistoryRef = useRef<Record<CharacterSide, ImageData[]>>({
    front: [],
    back: [],
  });
  const redoHistoryRef = useRef<Record<CharacterSide, ImageData[]>>({
    front: [],
    back: [],
  });
  const drawingRef = useRef(false);
  const activePointerRef = useRef<number | null>(null);
  const lastPointRef = useRef<Point | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  const [side, setSide] = useState<CharacterSide>("front");
  const [tool, setTool] = useState<DrawingTool>("pencil");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1].value);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [clearArmed, setClearArmed] = useState(false);
  const [status, setStatus] = useState(
    "앞면부터 자유롭게 그려 보세요. 선은 실루엣 밖으로 나가지 않아요.",
  );

  const paintVisibleCanvas = useCallback((whichSide: CharacterSide) => {
    const displayCanvas = displayCanvasRef.current;
    const drawingLayer = drawingLayersRef.current[whichSide];
    if (!displayCanvas || !drawingLayer) return;

    const context = displayCanvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawWorkspace(context);

    context.save();
    context.clip(createSilhouettePath());
    context.fillStyle = "#FFFCF5";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.drawImage(drawingLayer, 0, 0);
    context.restore();

    drawGuide(context, whichSide);
  }, []);

  useEffect(() => {
    for (const whichSide of ["front", "back"] as const) {
      if (!drawingLayersRef.current[whichSide]) {
        const layer = document.createElement("canvas");
        layer.width = CANVAS_WIDTH;
        layer.height = CANVAS_HEIGHT;
        drawingLayersRef.current[whichSide] = layer;
      }
    }
    paintVisibleCanvas(side);

    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, [paintVisibleCanvas, side]);

  useEffect(() => {
    paintVisibleCanvas(side);
  }, [paintVisibleCanvas, side]);

  const getPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0, pressure: 0.5 };

    const bounds = canvas.getBoundingClientRect();
    const penPressure =
      event.pointerType === "pen"
        ? Math.max(0.12, Math.min(1, event.pressure || 0.5))
        : 0.58;

    return {
      x: ((event.clientX - bounds.left) / bounds.width) * CANVAS_WIDTH,
      y: ((event.clientY - bounds.top) / bounds.height) * CANVAS_HEIGHT,
      pressure: penPressure,
    };
  };

  const saveUndoSnapshot = (whichSide: CharacterSide) => {
    const layer = drawingLayersRef.current[whichSide];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    const history = undoHistoryRef.current[whichSide];
    history.push(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    if (history.length > MAX_HISTORY) history.shift();
    redoHistoryRef.current[whichSide] = [];
    setHistoryRevision((revision) => revision + 1);
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const layer = drawingLayersRef.current[side];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    saveUndoSnapshot(side);
    drawingRef.current = true;
    activePointerRef.current = event.pointerId;

    const point = getPoint(event);
    lastPointRef.current = point;
    drawStroke(context, point, point, tool, color, brushSize);
    paintVisibleCanvas(side);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (
      !drawingRef.current ||
      activePointerRef.current !== event.pointerId ||
      !lastPointRef.current
    ) {
      return;
    }

    const layer = drawingLayersRef.current[side];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    event.preventDefault();
    const nextPoint = getPoint(event);
    drawStroke(
      context,
      lastPointRef.current,
      nextPoint,
      tool,
      color,
      brushSize,
    );
    lastPointRef.current = nextPoint;
    paintVisibleCanvas(side);
  };

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    drawingRef.current = false;
    activePointerRef.current = null;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const switchSide = (nextSide: CharacterSide) => {
    drawingRef.current = false;
    activePointerRef.current = null;
    lastPointRef.current = null;
    setClearArmed(false);
    setSide(nextSide);
    setStatus(
      nextSide === "front"
        ? "앞면을 편집하고 있어요. 뒷면 그림은 그대로 보관됩니다."
        : "뒷면을 편집하고 있어요. 앞면 그림은 그대로 보관됩니다.",
    );
  };

  const restoreSnapshot = (direction: "undo" | "redo") => {
    const layer = drawingLayersRef.current[side];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    const source =
      direction === "undo"
        ? undoHistoryRef.current[side]
        : redoHistoryRef.current[side];
    const target =
      direction === "undo"
        ? redoHistoryRef.current[side]
        : undoHistoryRef.current[side];
    const snapshot = source.pop();
    if (!snapshot) return;

    target.push(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    context.putImageData(snapshot, 0, 0);
    setHistoryRevision((revision) => revision + 1);
    paintVisibleCanvas(side);
    setClearArmed(false);
    setStatus(
      direction === "undo" ? "한 단계를 되돌렸어요." : "한 단계를 다시 적용했어요.",
    );
  };

  const handleClear = () => {
    if (!clearArmed) {
      setClearArmed(true);
      setStatus("한 번 더 누르면 현재 면의 그림을 지워요. 실행 취소도 가능합니다.");
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        setClearArmed(false);
      }, 3500);
      return;
    }

    const layer = drawingLayersRef.current[side];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;
    saveUndoSnapshot(side);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintVisibleCanvas(side);
    setClearArmed(false);
    setStatus("현재 면을 비웠어요. 필요하면 실행 취소로 되돌릴 수 있어요.");
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  };

  const createExportDataUrl = (whichSide: CharacterSide) => {
    const drawingLayer = drawingLayersRef.current[whichSide];
    if (!drawingLayer) return null;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = CANVAS_WIDTH;
    exportCanvas.height = CANVAS_HEIGHT;
    const context = exportCanvas.getContext("2d");
    if (!context) return null;

    context.save();
    context.clip(createSilhouettePath());
    context.fillStyle = "#FFFCF5";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.drawImage(drawingLayer, 0, 0);
    context.restore();

    return exportCanvas.toDataURL("image/png");
  };

  const downloadPng = () => {
    const dataUrl = createExportDataUrl(side);
    if (!dataUrl) return;

    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `my-character-${side}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(
      `${side === "front" ? "앞면" : "뒷면"}을 투명 PNG로 저장했어요.`,
    );
  };

  const sendToStudio = () => {
    const dataUrl = createExportDataUrl(side);
    if (!dataUrl) return;
    onSendToStudio?.(dataUrl);
    setStatus(
      onSendToStudio
        ? "현재 캐릭터를 트래킹 스튜디오로 보냈어요."
        : "캐릭터 PNG가 준비됐어요. 스튜디오 연결 후 바로 보낼 수 있어요.",
    );
  };

  const canUndo = undoHistoryRef.current[side].length > 0;
  const canRedo = redoHistoryRef.current[side].length > 0;
  void historyRevision;

  return (
    <section className={styles.creator} aria-labelledby="character-creator-title">
      <header className={styles.heading}>
        <span className={styles.eyebrow}>CHARACTER MAKER</span>
        <div>
          <h2 id="character-creator-title">내 손으로 만드는 캐릭터</h2>
          <p>
            정해진 몸 위에 색과 무늬를 더해 보세요. 가이드 밖의 선은 자동으로
            잘리고, 앞면과 뒷면은 따로 보관됩니다.
          </p>
        </div>
      </header>

      <div className={styles.editorGrid}>
        <aside className={styles.controlPanel} aria-label="그리기 도구">
          <div className={styles.controlGroup}>
            <div className={styles.groupLabel}>보이는 면</div>
            <div className={styles.segmented} role="group" aria-label="캐릭터 면 선택">
              <button
                type="button"
                className={side === "front" ? styles.segmentActive : ""}
                aria-pressed={side === "front"}
                onClick={() => switchSide("front")}
              >
                앞면
              </button>
              <button
                type="button"
                className={side === "back" ? styles.segmentActive : ""}
                aria-pressed={side === "back"}
                onClick={() => switchSide("back")}
              >
                뒷면
              </button>
            </div>
          </div>

          <div className={styles.controlGroup}>
            <div className={styles.groupLabel}>도구</div>
            <div className={styles.toolGrid}>
              <button
                type="button"
                className={`${styles.toolButton} ${
                  tool === "pencil" ? styles.toolActive : ""
                }`}
                aria-pressed={tool === "pencil"}
                onClick={() => setTool("pencil")}
              >
                <Pencil size={18} strokeWidth={2} aria-hidden="true" />
                연필
              </button>
              <button
                type="button"
                className={`${styles.toolButton} ${
                  tool === "eraser" ? styles.toolActive : ""
                }`}
                aria-pressed={tool === "eraser"}
                onClick={() => setTool("eraser")}
              >
                <Eraser size={18} strokeWidth={2} aria-hidden="true" />
                지우개
              </button>
            </div>
          </div>

          <fieldset className={styles.controlGroup}>
            <legend className={styles.groupLabel}>색상</legend>
            <div className={styles.palette}>
              {PALETTE.map((paletteColor) => (
                <button
                  key={paletteColor}
                  type="button"
                  className={`${styles.swatch} ${
                    color.toUpperCase() === paletteColor ? styles.swatchActive : ""
                  }`}
                  style={{ backgroundColor: paletteColor }}
                  aria-label={`${paletteColor} 색상 선택`}
                  aria-pressed={color.toUpperCase() === paletteColor}
                  onClick={() => {
                    setColor(paletteColor);
                    setTool("pencil");
                  }}
                />
              ))}
              <label className={styles.customColor} title="직접 색상 고르기">
                <span className={styles.rainbow} aria-hidden="true" />
                <span className={styles.srOnly}>직접 색상 고르기</span>
                <input
                  type="color"
                  value={color}
                  onChange={(event) => {
                    setColor(event.target.value);
                    setTool("pencil");
                  }}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className={styles.controlGroup}>
            <legend className={styles.groupLabel}>선 굵기</legend>
            <div className={styles.sizePicker}>
              {BRUSH_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  className={brushSize === size.value ? styles.sizeActive : ""}
                  aria-label={`${size.label} 선 굵기`}
                  aria-pressed={brushSize === size.value}
                  onClick={() => setBrushSize(size.value)}
                >
                  <span
                    className={styles.sizeDot}
                    style={{ width: size.value, height: size.value }}
                    aria-hidden="true"
                  />
                  <span>{size.label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className={styles.controlGroup}>
            <div className={styles.groupLabel}>편집</div>
            <div className={styles.historyRow}>
              <button
                type="button"
                disabled={!canUndo}
                onClick={() => restoreSnapshot("undo")}
                aria-label="실행 취소"
              >
                <Undo2 size={18} aria-hidden="true" />
                되돌리기
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => restoreSnapshot("redo")}
                aria-label="다시 실행"
              >
                <Redo2 size={18} aria-hidden="true" />
                다시
              </button>
            </div>
            <button
              type="button"
              className={`${styles.clearButton} ${
                clearArmed ? styles.clearArmed : ""
              }`}
              onClick={handleClear}
            >
              <Trash2 size={17} aria-hidden="true" />
              {clearArmed ? "한 번 더 눌러 지우기" : "현재 면 모두 지우기"}
            </button>
          </div>

          <div className={styles.tipBox}>
            <span aria-hidden="true">✦</span>
            <p>
              펜을 기울이거나 세게 누르면 압력이 반영돼요. 터치 화면에서도 바로
              그릴 수 있습니다.
            </p>
          </div>
        </aside>

        <div className={styles.stageColumn}>
          <div className={styles.stageMeta}>
            <span>
              <i aria-hidden="true" />
              {side === "front" ? "앞면 편집 중" : "뒷면 편집 중"}
            </span>
            <span className={styles.guideNotice}>점선 가이드는 저장되지 않아요</span>
          </div>

          <div className={styles.canvasFrame}>
            <canvas
              ref={displayCanvasRef}
              className={styles.canvas}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              aria-label={`${side === "front" ? "앞면" : "뒷면"} 캐릭터 그리기 영역`}
              aria-describedby="character-canvas-help"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              onContextMenu={(event) => event.preventDefault()}
            />
            <span className={styles.sideBadge} aria-hidden="true">
              {side === "front" ? "FRONT" : "BACK"}
            </span>
          </div>

          <p id="character-canvas-help" className={styles.canvasHelp}>
            마우스나 손가락으로 실루엣 안을 그리세요. 내보낼 때 회색 가이드와
            작업 배경은 자동으로 빠집니다.
          </p>

          <div className={styles.status} aria-live="polite">
            {status}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.downloadButton} onClick={downloadPng}>
              <Download size={19} aria-hidden="true" />
              현재 면 PNG 저장
            </button>
            <button type="button" className={styles.sendButton} onClick={sendToStudio}>
              <Send size={19} aria-hidden="true" />
              스튜디오로 보내기
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CharacterCreator;
