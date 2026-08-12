"use client";

import {
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
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import styles from "./CharacterCreator.module.css";

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 760;
const MAX_HISTORY = 14;

type CharacterSide = "front" | "back";
const EDITOR_SIDE = "front" as const satisfies CharacterSide;
type DrawingTool = "pencil" | "eraser" | "fill";

type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type CharacterCreatorProps = {
  initialArtwork?: string | null;
  initialArtworkKey?: string;
  disabled?: boolean;
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

const BRUSH_SIZE_MIN = 2;
const BRUSH_SIZE_MAX = 40;
const BRUSH_SIZE_STEP = 1;
const DEFAULT_BRUSH_SIZE = 14;

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

function drawGuide(context: CanvasRenderingContext2D) {
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
    if (from === joints.head && to === joints.neck) {
      // Keep the blue head bone out of the facial drawing area.
      context.moveTo(300, 188);
      context.lineTo(to.x, to.y);
      continue;
    }
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  }
  context.stroke();

  context.strokeStyle = "rgba(53, 58, 66, 0.34)";
  context.lineWidth = 1.5;

  // Facial landmarks are display-only drawing anchors. Each semantic line
  // matches a separately warped region in the paper-doll face mesh, without
  // baking guide pixels into the transparent PNG.
  context.beginPath();
  context.moveTo(248, 78);
  context.bezierCurveTo(238, 110, 242, 156, 263, 176);
  context.quadraticCurveTo(300, 201, 337, 176);
  context.bezierCurveTo(358, 156, 362, 110, 352, 78);
  context.stroke();

  // Left/right brows: outer, arch, and inner anchors remain independent.
  context.beginPath();
  context.moveTo(254, 92);
  context.quadraticCurveTo(269, 81, 286, 91);
  context.moveTo(314, 91);
  context.quadraticCurveTo(331, 81, 346, 92);
  context.stroke();

  // Left/right eyes: separate upper/lower lids plus iris centers make blink
  // and gaze strokes easier to place than a single oval.
  context.beginPath();
  context.moveTo(255, 111);
  context.quadraticCurveTo(270, 101, 285, 111);
  context.quadraticCurveTo(270, 120, 255, 111);
  context.moveTo(315, 111);
  context.quadraticCurveTo(330, 101, 345, 111);
  context.quadraticCurveTo(330, 120, 315, 111);
  context.stroke();
  context.beginPath();
  context.arc(270, 111, 3.2, 0, Math.PI * 2);
  context.arc(330, 111, 3.2, 0, Math.PI * 2);
  context.stroke();

  // Nose bridge, tip, and left/right wings each have their own anchors.
  context.beginPath();
  context.moveTo(300, 116);
  context.quadraticCurveTo(297, 126, 297, 134);
  context.quadraticCurveTo(300, 139, 303, 134);
  context.moveTo(288, 139);
  context.quadraticCurveTo(294, 143, 300, 140);
  context.quadraticCurveTo(306, 143, 312, 139);
  context.stroke();

  // Upper lip, lower lip, and both corners are intentionally separate.
  context.beginPath();
  context.moveTo(275, 152);
  context.quadraticCurveTo(288, 148, 300, 143);
  context.quadraticCurveTo(312, 148, 325, 152);
  context.moveTo(275, 152);
  context.quadraticCurveTo(300, 168, 325, 152);
  context.moveTo(283, 153);
  context.quadraticCurveTo(300, 158, 317, 153);
  context.stroke();

  const semanticAnchors = [
    [254, 92], [286, 91], [314, 91], [346, 92],
    [255, 111], [285, 111], [315, 111], [345, 111],
    [300, 116], [300, 140], [288, 139], [312, 139],
    [275, 152], [300, 143], [300, 164], [325, 152], [300, 184],
  ] as const;
  context.fillStyle = "rgba(255, 107, 74, 0.58)";
  for (const [x, y] of semanticAnchors) {
    context.beginPath();
    context.arc(x, y, 2.3, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.strokeStyle = "rgba(77, 111, 230, 0.82)";
  context.lineWidth = 2.4;
  for (const joint of Object.values(joints)) {
    if (joint === joints.head) continue;
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
  disabled = false,
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
  const artworkImportPendingRef = useRef(false);
  const importedArtworkKeyRef = useRef<string | null>(null);
  const importedArtworkRef = useRef<string | null | undefined>(undefined);

  const [tool, setTool] = useState<DrawingTool>("pencil");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const brushSizeInputId = useId();
  const [brushSize, setBrushSize] = useState<number>(DEFAULT_BRUSH_SIZE);
  const [historyAvailability, setHistoryAvailability] = useState({
    front: { undo: false, redo: false },
    back: { undo: false, redo: false },
  });
  const [clearArmed, setClearArmed] = useState(false);
  const [sendingToStudio, setSendingToStudio] = useState(false);
  const [importingArtwork, setImportingArtwork] = useState(false);
  const [status, setStatus] = useState(
    "자유롭게 그려 보세요. 몸 밖의 소매·치마·머리카락도 함께 움직여요.",
  );

  const paintVisibleCanvas = useCallback(() => {
    const displayCanvas = displayCanvasRef.current;
    const drawingLayer = drawingLayersRef.current[EDITOR_SIDE];
    if (!displayCanvas || !drawingLayer) return;

    const context = displayCanvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawWorkspace(context);
    context.drawImage(drawingLayer, 0, 0);

    drawGuide(context);
  }, []);

  useLayoutEffect(() => {
    for (const whichSide of ["front", "back"] as const) {
      if (!drawingLayersRef.current[whichSide]) {
        const layer = document.createElement("canvas");
        layer.width = CANVAS_WIDTH;
        layer.height = CANVAS_HEIGHT;
        drawingLayersRef.current[whichSide] = layer;
      }
    }
    paintVisibleCanvas();

    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, [paintVisibleCanvas]);

  useLayoutEffect(() => {
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
    const frontLayer = drawingLayersRef.current.front;
    const backLayer = drawingLayersRef.current.back;
    const frontContext = frontLayer?.getContext("2d");
    const backContext = backLayer?.getContext("2d");
    if (!frontLayer || !backLayer || !frontContext || !backContext) return;

    // Commit the new editor session before the browser can paint or accept a
    // pointer event. A slow PNG decode must never leave the previous slot's
    // pixels available to the next slot or a new blank character.
    artworkImportPendingRef.current = Boolean(initialArtwork);
    drawingRef.current = false;
    activePointerRef.current = null;
    lastPointRef.current = null;
    frontContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    backContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const blankFront = frontContext.getImageData(
      0,
      0,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    );
    undoHistoryRef.current = { front: [], back: [] };
    redoHistoryRef.current = { front: [], back: [] };
    setHistoryAvailability({
      front: { undo: false, redo: false },
      back: { undo: false, redo: false },
    });
    setImportingArtwork(Boolean(initialArtwork));
    paintVisibleCanvas();

    const image = initialArtwork ? new Image() : null;
    const applyArtwork = (loadedImage: HTMLImageElement | null, failed = false) => {
      if (artworkImportGenerationRef.current !== generation) return;
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
      artworkImportPendingRef.current = false;
      setImportingArtwork(false);
      setHistoryAvailability({
        front: { undo: Boolean(loadedImage), redo: false },
        back: { undo: false, redo: false },
      });
      paintVisibleCanvas();
      if (failed) {
        setStatus("저장된 캐릭터를 불러오지 못해 투명 캔버스로 시작했어요.");
      } else if (loadedImage) {
        setStatus("캐릭터를 불러왔어요.");
      } else {
        setStatus("새 투명 캔버스를 준비했어요.");
      }
    };

    if (image && initialArtwork) {
      image.decoding = "async";
      image.onload = () => applyArtwork(image);
      image.onerror = () => applyArtwork(null, true);
      image.src = initialArtwork;
    } else {
      applyArtwork(null);
    }

    return () => {
      if (image) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, [initialArtwork, initialArtworkKey, paintVisibleCanvas]);

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
    setHistoryAvailability((current) => ({
      ...current,
      [whichSide]: { undo: history.length > 0, redo: false },
    }));
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (disabled || artworkImportPendingRef.current) {
      event.preventDefault();
      setStatus(
        disabled
          ? "캐릭터 보관함 작업이 끝난 뒤 이어 그릴 수 있어요."
          : "저장된 캐릭터를 불러오는 중이에요. 잠시 후 이어 그려 주세요.",
      );
      return;
    }

    const layer = drawingLayersRef.current[EDITOR_SIDE];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    event.preventDefault();
    if (tool === "fill") {
      saveUndoSnapshot(EDITOR_SIDE);
      context.save();
      context.clip(createSilhouettePath());
      context.fillStyle = color;
      context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      context.restore();
      paintVisibleCanvas();
      setStatus("몸 전체에 바탕색을 채웠어요. 그 위에 무늬와 얼굴을 그려 보세요.");
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    saveUndoSnapshot(EDITOR_SIDE);
    drawingRef.current = true;
    activePointerRef.current = event.pointerId;

    const point = getPoint(event);
    lastPointRef.current = point;
    drawStroke(context, point, point, tool, color, brushSize);
    paintVisibleCanvas();
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (disabled) {
      drawingRef.current = false;
      activePointerRef.current = null;
      lastPointRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (
      !drawingRef.current ||
      activePointerRef.current !== event.pointerId ||
      !lastPointRef.current
    ) {
      return;
    }

    const layer = drawingLayersRef.current[EDITOR_SIDE];
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
    paintVisibleCanvas();
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

  const restoreSnapshot = (direction: "undo" | "redo") => {
    if (disabled || artworkImportPendingRef.current) return;
    const layer = drawingLayersRef.current[EDITOR_SIDE];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;

    const source =
      direction === "undo"
        ? undoHistoryRef.current[EDITOR_SIDE]
        : redoHistoryRef.current[EDITOR_SIDE];
    const target =
      direction === "undo"
        ? redoHistoryRef.current[EDITOR_SIDE]
        : undoHistoryRef.current[EDITOR_SIDE];
    const snapshot = source.pop();
    if (!snapshot) return;

    target.push(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    context.putImageData(snapshot, 0, 0);
    setHistoryAvailability((current) => ({
      ...current,
      [EDITOR_SIDE]: {
        undo: undoHistoryRef.current[EDITOR_SIDE].length > 0,
        redo: redoHistoryRef.current[EDITOR_SIDE].length > 0,
      },
    }));
    paintVisibleCanvas();
    setClearArmed(false);
    setStatus(
      direction === "undo" ? "한 단계를 되돌렸어요." : "한 단계를 다시 적용했어요.",
    );
  };

  const handleClear = () => {
    if (disabled || artworkImportPendingRef.current) {
      setStatus(
        disabled
          ? "캐릭터 보관함 작업이 끝난 뒤 지울 수 있어요."
          : "저장된 캐릭터를 불러오는 중이에요. 잠시 후 지울 수 있어요.",
      );
      return;
    }
    if (!clearArmed) {
      setClearArmed(true);
      setStatus("한 번 더 누르면 그림을 지워요. 실행 취소도 가능합니다.");
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        setClearArmed(false);
      }, 3500);
      return;
    }

    const layer = drawingLayersRef.current[EDITOR_SIDE];
    const context = layer?.getContext("2d");
    if (!layer || !context) return;
    saveUndoSnapshot(EDITOR_SIDE);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintVisibleCanvas();
    setClearArmed(false);
    setStatus("그림을 비웠어요. 필요하면 실행 취소로 되돌릴 수 있어요.");
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  };

  const createExportDataUrl = () => {
    const drawingLayer = drawingLayersRef.current[EDITOR_SIDE];
    if (!drawingLayer) return null;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = CANVAS_WIDTH;
    exportCanvas.height = CANVAS_HEIGHT;
    const context = exportCanvas.getContext("2d");
    if (!context) return null;

    context.drawImage(drawingLayer, 0, 0);

    return exportCanvas.toDataURL("image/png");
  };

  const sendToStudio = async () => {
    if (disabled || artworkImportPendingRef.current) {
      setStatus(
        disabled
          ? "캐릭터 보관함 작업이 끝난 뒤 스튜디오로 보낼 수 있어요."
          : "저장된 캐릭터를 모두 불러온 뒤 스튜디오로 보낼 수 있어요.",
      );
      return;
    }
    const dataUrl = createExportDataUrl();
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

  const canUndo = historyAvailability[EDITOR_SIDE].undo;
  const canRedo = historyAvailability[EDITOR_SIDE].redo;
  const editorDisabled = disabled || importingArtwork;

  return (
    <section className={styles.creator} aria-label="캐릭터 만들기">
      <div className={styles.editorGrid}>
        <aside className={styles.controlPanel} aria-label="그리기 도구">
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
                disabled={editorDisabled}
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
                disabled={editorDisabled}
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
                disabled={editorDisabled}
              >
                <PaintBucket size={18} strokeWidth={2} aria-hidden="true" />
                바탕 채우기
              </button>
            </div>
          </div>

          <fieldset className={styles.controlGroup} disabled={editorDisabled}>
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

          <fieldset className={styles.controlGroup} disabled={editorDisabled}>
            <legend className={styles.groupLabel}>선 굵기</legend>
            <div className={styles.brushSizeControl}>
              <div className={styles.brushSizePreview} aria-hidden="true">
                <span
                  className={styles.brushSizeDot}
                  style={{ width: brushSize, height: brushSize }}
                />
              </div>
              <div className={styles.brushSizeSliderGroup}>
                <div className={styles.brushSizeMeta}>
                  <span>{BRUSH_SIZE_MIN}px</span>
                  <output htmlFor={brushSizeInputId} aria-live="polite">
                    {brushSize}px
                  </output>
                  <span>{BRUSH_SIZE_MAX}px</span>
                </div>
                <label className={styles.srOnly} htmlFor={brushSizeInputId}>
                  선 굵기
                </label>
                <input
                  id={brushSizeInputId}
                  className={styles.brushSizeSlider}
                  type="range"
                  min={BRUSH_SIZE_MIN}
                  max={BRUSH_SIZE_MAX}
                  step={BRUSH_SIZE_STEP}
                  value={brushSize}
                  aria-valuetext={`${brushSize}px`}
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                />
              </div>
            </div>
          </fieldset>

          <div className={styles.controlGroup}>
            <div className={styles.groupLabel}>편집</div>
            <div className={styles.historyRow}>
              <button
                type="button"
                disabled={!canUndo || editorDisabled}
                onClick={() => restoreSnapshot("undo")}
                aria-label="실행 취소"
              >
                <Undo2 size={18} aria-hidden="true" />
                되돌리기
              </button>
              <button
                type="button"
                disabled={!canRedo || editorDisabled}
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
              disabled={editorDisabled}
            >
              <Trash2 size={17} aria-hidden="true" />
              {clearArmed ? "한 번 더 눌러 지우기" : "그림 모두 지우기"}
            </button>
          </div>

          <div className={styles.panelActions} aria-label="캐릭터 저장">
            <button
              type="button"
              className={styles.sendButton}
              onClick={() => void sendToStudio()}
              disabled={sendingToStudio || editorDisabled}
              aria-busy={sendingToStudio || editorDisabled}
            >
              <Send size={18} aria-hidden="true" />
              {disabled
                ? "보관함 처리 중…"
                : importingArtwork
                ? "캐릭터 불러오는 중…"
                : sendingToStudio
                  ? "저장 중…"
                  : "저장하고 스튜디오로"}
            </button>
          </div>
        </aside>

        <div className={styles.stageColumn}>
          <p id="character-face-guide-help" className={styles.srOnly}>
            얼굴 가이드에는 좌우 눈과 눈썹, 코, 입술, 입꼬리, 턱 기준점이
            표시됩니다.
          </p>

          <div className={styles.canvasFrame}>
            <canvas
              ref={displayCanvasRef}
              className={styles.canvas}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              aria-label="앞면 캐릭터 그리기 영역"
              aria-busy={editorDisabled}
              aria-disabled={editorDisabled}
              aria-describedby="character-face-guide-help character-canvas-help"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              onContextMenu={(event) => event.preventDefault()}
            />
          </div>

          <p id="character-canvas-help" className={styles.srOnly}>
            투명 캔버스의 T-포즈 안팎 어디든 그릴 수 있으며, 모든 가이드와 체크무늬는 결과물에 저장되지 않습니다.
          </p>

          <div className={styles.srOnly} role="status" aria-live="polite">
            {status}
          </div>

        </div>
      </div>
    </section>
  );
}

export default CharacterCreator;
