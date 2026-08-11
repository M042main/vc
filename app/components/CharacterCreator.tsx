"use client";

import {
  Download,
  Eraser,
  PaintBucket,
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
const MAX_HISTORY = 14;

type CharacterSide = "front" | "back";
type DrawingTool = "pencil" | "eraser" | "fill";

type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type CharacterCreatorProps = {
  initialArtwork?: string | null;
  initialArtworkKey?: string;
  onSendToStudio?: (dataUrl: string) => void | Promise<void>;
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
  path.bezierCurveTo(348, 207, 365, 210, 382, 214);
  path.lineTo(552, 214);
  path.bezierCurveTo(568, 214, 578, 223, 578, 238);
  path.bezierCurveTo(578, 252, 568, 262, 553, 262);
  path.lineTo(382, 262);
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
  path.lineTo(218, 262);
  path.lineTo(47, 262);
  path.bezierCurveTo(32, 262, 22, 252, 22, 238);
  path.bezierCurveTo(22, 223, 32, 214, 48, 214);
  path.lineTo(218, 214);
  path.bezierCurveTo(235, 210, 252, 207, 272, 204);
  path.lineTo(272, 191);
  path.bezierCurveTo(246, 179, 229, 150, 229, 105);
  path.bezierCurveTo(229, 58, 258, 24, 300, 24);
  path.closePath();

  return path;
}

function drawWorkspace(context: CanvasRenderingContext2D) {
  const checkerSize = 24;
  context.fillStyle = "#F8F7F3";
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  context.fillStyle = "rgba(78, 83, 92, 0.055)";
  for (let y = 0; y < CANVAS_HEIGHT; y += checkerSize) {
    for (let x = 0; x < CANVAS_WIDTH; x += checkerSize) {
      if ((x / checkerSize + y / checkerSize) % 2 === 0) {
        context.fillRect(x, y, checkerSize, checkerSize);
      }
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
  const joints = {
    head: { x: 300, y: 111 },
    neck: { x: 300, y: 202 },
    leftShoulder: { x: 221, y: 238 },
    leftElbow: { x: 126, y: 238 },
    leftWrist: { x: 42, y: 238 },
    rightShoulder: { x: 379, y: 238 },
    rightElbow: { x: 474, y: 238 },
    rightWrist: { x: 558, y: 238 },
    pelvis: { x: 300, y: 470 },
    leftHip: { x: 268, y: 470 },
    leftKnee: { x: 236, y: 572 },
    leftAnkle: { x: 226, y: 704 },
    rightHip: { x: 332, y: 470 },
    rightKnee: { x: 364, y: 572 },
    rightAnkle: { x: 374, y: 704 },
  } as const;
  const bones = [
    [joints.head, joints.neck],
    [joints.neck, joints.leftShoulder],
    [joints.neck, joints.rightShoulder],
    [joints.leftShoulder, joints.leftElbow],
    [joints.leftElbow, joints.leftWrist],
    [joints.rightShoulder, joints.rightElbow],
    [joints.rightElbow, joints.rightWrist],
    [joints.neck, joints.pelvis],
    [joints.leftHip, joints.rightHip],
    [joints.leftHip, joints.leftKnee],
    [joints.leftKnee, joints.leftAnkle],
    [joints.rightHip, joints.rightKnee],
    [joints.rightKnee, joints.rightAnkle],
  ] as const;

  context.save();
  context.strokeStyle = "rgba(53, 58, 66, 0.48)";
  context.lineWidth = 2;
  context.setLineDash([8, 7]);
  context.stroke(silhouette);

  context.strokeStyle = "rgba(77, 111, 230, 0.58)";
  context.lineWidth = 3.2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash([]);
  context.beginPath();
  for (const [from, to] of bones) {
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  }
  context.stroke();

  if (side === "front") {
    context.strokeStyle = "rgba(53, 58, 66, 0.34)";
    context.lineWidth = 1.5;

    // Facial landmarks are display-only drawing anchors. Keeping the jaw,
    // brows, eyes, nose, and mouth separate mirrors the regions animated by
    // the paper-doll face mesh without baking any guide pixels into the PNG.
    context.beginPath();
    context.moveTo(248, 78);
    context.bezierCurveTo(238, 110, 242, 156, 263, 176);
    context.quadraticCurveTo(300, 201, 337, 176);
    context.bezierCurveTo(358, 156, 362, 110, 352, 78);
    context.stroke();

    context.beginPath();
    context.moveTo(255, 91);
    context.quadraticCurveTo(270, 82, 285, 91);
    context.moveTo(315, 91);
    context.quadraticCurveTo(330, 82, 345, 91);
    context.stroke();

    context.beginPath();
    context.ellipse(270, 111, 14, 7, 0, 0, Math.PI * 2);
    context.ellipse(330, 111, 14, 7, 0, 0, Math.PI * 2);
    context.stroke();

    context.beginPath();
    context.moveTo(300, 113);
    context.quadraticCurveTo(296, 128, 294, 136);
    context.quadraticCurveTo(300, 141, 306, 136);
    context.stroke();

    context.beginPath();
    context.moveTo(276, 151);
    context.quadraticCurveTo(300, 139, 324, 151);
    context.quadraticCurveTo(300, 166, 276, 151);
    context.moveTo(284, 151);
    context.quadraticCurveTo(300, 156, 316, 151);
    context.stroke();
  } else {
    context.strokeStyle = "rgba(53, 58, 66, 0.34)";
    context.lineWidth = 1.5;
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

  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.strokeStyle = "rgba(77, 111, 230, 0.82)";
  context.lineWidth = 2.4;
  for (const joint of Object.values(joints)) {
    context.beginPath();
    context.arc(joint.x, joint.y, joint === joints.head ? 7 : 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
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
  initialArtwork,
  initialArtworkKey,
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
  const artworkImportGenerationRef = useRef(0);
  const importedArtworkKeyRef = useRef<string | null>(null);
  const importedArtworkRef = useRef<string | null | undefined>(undefined);

  const [side, setSide] = useState<CharacterSide>("front");
  const [tool, setTool] = useState<DrawingTool>("pencil");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1].value);
  const [historyAvailability, setHistoryAvailability] = useState({
    front: { undo: false, redo: false },
    back: { undo: false, redo: false },
  });
  const [clearArmed, setClearArmed] = useState(false);
  const [sendingToStudio, setSendingToStudio] = useState(false);
  const [status, setStatus] = useState(
    "앞면부터 자유롭게 그려 보세요. 몸 밖의 소매·치마·머리카락도 함께 움직여요.",
  );

  const paintVisibleCanvas = useCallback((whichSide: CharacterSide) => {
    const displayCanvas = displayCanvasRef.current;
    const drawingLayer = drawingLayersRef.current[whichSide];
    if (!displayCanvas || !drawingLayer) return;

    const context = displayCanvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawWorkspace(context);
    context.drawImage(drawingLayer, 0, 0);

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

  useEffect(() => {
    const importKey =
      initialArtworkKey?.trim() ||
      (initialArtwork ? `artwork:${initialArtwork}` : "empty-front-artwork");
    if (
      importedArtworkKeyRef.current === importKey &&
      importedArtworkRef.current === initialArtwork
    ) {
      return;
    }

    const generation = artworkImportGenerationRef.current + 1;
    artworkImportGenerationRef.current = generation;
    let resetTimer: number | null = null;
    const image = initialArtwork ? new Image() : null;

    const applyArtwork = (loadedImage: HTMLImageElement | null, failed = false) => {
      if (artworkImportGenerationRef.current !== generation) return;
      const frontLayer = drawingLayersRef.current.front;
      const backLayer = drawingLayersRef.current.back;
      const frontContext = frontLayer?.getContext("2d");
      const backContext = backLayer?.getContext("2d");
      if (!frontLayer || !backLayer || !frontContext || !backContext) return;

      frontContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      backContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const blankFront = frontContext.getImageData(
        0,
        0,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      if (loadedImage) {
        frontContext.drawImage(loadedImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }

      undoHistoryRef.current = {
        front: loadedImage ? [blankFront] : [],
        back: [],
      };
      redoHistoryRef.current = { front: [], back: [] };
      importedArtworkKeyRef.current = importKey;
      importedArtworkRef.current = initialArtwork;
      setHistoryAvailability({
        front: { undo: Boolean(loadedImage), redo: false },
        back: { undo: false, redo: false },
      });
      paintVisibleCanvas(side);
      if (failed) {
        setStatus("저장된 캐릭터를 불러오지 못해 투명 캔버스로 시작했어요.");
      } else if (loadedImage) {
        setStatus("저장된 T-포즈 캐릭터를 불러왔어요. 그대로 이어 그릴 수 있어요.");
      }
    };

    if (image && initialArtwork) {
      image.decoding = "async";
      image.onload = () => applyArtwork(image);
      image.onerror = () => applyArtwork(null, true);
      image.src = initialArtwork;
    } else {
      resetTimer = window.setTimeout(() => applyArtwork(null), 0);
    }

    return () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      if (image) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, [initialArtwork, initialArtworkKey, paintVisibleCanvas, side]);

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
    // A user's first stroke wins over a still-loading saved image so an older
    // profile can never overwrite fresh work after an asynchronous decode.
    artworkImportGenerationRef.current += 1;
    const layer = drawingLayersRef.current[whichSide];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    const history = undoHistoryRef.current[whichSide];
    history.push(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    if (history.length > MAX_HISTORY) history.shift();
    redoHistoryRef.current[whichSide] = [];
    setHistoryAvailability((current) => ({
      ...current,
      [whichSide]: { undo: history.length > 0, redo: false },
    }));
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const layer = drawingLayersRef.current[side];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    event.preventDefault();
    if (tool === "fill") {
      saveUndoSnapshot(side);
      context.save();
      context.clip(createSilhouettePath());
      context.fillStyle = color;
      context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      context.restore();
      paintVisibleCanvas(side);
      setStatus("몸 전체에 바탕색을 채웠어요. 그 위에 무늬와 얼굴을 그려 보세요.");
      return;
    }

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
    setHistoryAvailability((current) => ({
      ...current,
      [side]: {
        undo: undoHistoryRef.current[side].length > 0,
        redo: redoHistoryRef.current[side].length > 0,
      },
    }));
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

    context.drawImage(drawingLayer, 0, 0);

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
      `${side === "front" ? "앞면" : "뒷면"}을 투명 PNG로 저장했어요. 스튜디오로 보내면 바로 애니메이션을 만들 수 있어요.`,
    );
  };

  const sendToStudio = async () => {
    const dataUrl = createExportDataUrl("front");
    if (!dataUrl || sendingToStudio) return;
    setSendingToStudio(true);
    try {
      await onSendToStudio?.(dataUrl);
      setStatus(
        onSendToStudio
          ? "투명 캐릭터를 저장하고 애니메이션 스튜디오로 보냈어요."
          : "투명 캐릭터 PNG가 준비됐어요. 스튜디오 연결 후 바로 보낼 수 있어요.",
      );
    } catch {
      setStatus("캐릭터를 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setSendingToStudio(false);
    }
  };

  const canUndo = historyAvailability[side].undo;
  const canRedo = historyAvailability[side].redo;

  return (
    <section className={styles.creator} aria-labelledby="character-creator-title">
      <header className={styles.heading}>
        <span className={styles.eyebrow}>CHARACTER MAKER</span>
        <div>
          <h2 id="character-creator-title">내 손으로 만드는 캐릭터</h2>
          <p>
            투명 캔버스의 스켈레톤 위에 몸과 옷을 자유롭게 그려 보세요. 실루엣
            밖의 소매·치마·머리카락도 가까운 관절을 따라 움직이고, 얼굴의 각
            부위는 카메라 표정을 따라갑니다.
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
              <button
                type="button"
                className={`${styles.toolButton} ${
                  tool === "fill" ? styles.toolActive : ""
                }`}
                aria-pressed={tool === "fill"}
                onClick={() => setTool("fill")}
              >
                <PaintBucket size={18} strokeWidth={2} aria-hidden="true" />
                바탕 채우기
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
              팔은 수평 T-포즈를 따라 그리세요. 눈·눈썹·코·입·턱 가이드에 맞추면
              깜박임, 눈썹, 미소, 입 벌림과 턱 움직임이 각각 반영돼요. 모든
              가이드와 체크무늬는 결과물에 저장되지 않습니다.
            </p>
          </div>
        </aside>

        <div className={styles.stageColumn}>
          <div className={styles.stageMeta}>
            <span>
              <i aria-hidden="true" />
              T-포즈 · {side === "front" ? "앞면 편집 중" : "뒷면 편집 중"}
            </span>
            <span className={styles.guideNotice}>
              투명 원본 · T-포즈 관절·표정 가이드는 저장되지 않아요
            </span>
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
            체크무늬는 투명 영역입니다. T-포즈 안팎 어디든 그릴 수 있으며 몸
            밖의 픽셀도 가장 가까운 머리·몸통·팔·다리에 자동으로 붙습니다.
          </p>

          <div className={styles.status} aria-live="polite">
            {status}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.downloadButton} onClick={downloadPng}>
              <Download size={19} aria-hidden="true" />
              현재 면 PNG 저장
            </button>
            <button
              type="button"
              className={styles.sendButton}
              onClick={() => void sendToStudio()}
              disabled={sendingToStudio}
              aria-busy={sendingToStudio}
            >
              <Send size={19} aria-hidden="true" />
              {sendingToStudio ? "저장 중…" : "저장하고 스튜디오로"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CharacterCreator;
