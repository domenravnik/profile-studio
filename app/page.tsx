"use client";

import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  Crop,
  Download,
  FileCheck2,
  FileJson,
  FolderArchive,
  Grid3X3,
  Hexagon,
  Image as ImageIcon,
  Layers3,
  Maximize2,
  MousePointer2,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import JSZip from "jszip";
import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Step = "samples" | "geometry" | "region" | "model" | "review";
type GeometryMode = "full" | "crop" | "annulus";
type RegionMode = "none" | "static" | "dynamic";
type DrawingTool = "select" | "polygon" | "ellipse";
type Operation = "include" | "exclude";

type Point = { x: number; y: number };
type PolygonShape = {
  id: string;
  type: "polygon";
  operation: Operation;
  name: string;
  points: Point[];
};
type EllipseShape = {
  id: string;
  type: "ellipse";
  operation: Operation;
  name: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};
type RoiShape = PolygonShape | EllipseShape;

type SampleImage = {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
};

type CropGeometry = { x: number; y: number; width: number; height: number };
type AnnulusGeometry = {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
  stripHeight: number;
  stripWidth: number;
};

type DragState =
  | {
      kind: "shape";
      shapeId: string;
      start: Point;
      original: RoiShape;
    }
  | {
      kind: "crop";
      start: Point;
      original: CropGeometry;
    }
  | {
      kind: "annulus";
      start: Point;
      original: AnnulusGeometry;
    }
  | null;

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "samples", label: "Samples" },
  { id: "geometry", label: "Geometry" },
  { id: "region", label: "Valid region" },
  { id: "model", label: "Model" },
  { id: "review", label: "Review" },
];

const DEFAULT_CANVAS_WIDTH = 1936;
const DEFAULT_CANVAS_HEIGHT = 1216;

const initialShapes: RoiShape[] = [
  {
    id: "shape-boundary",
    type: "polygon",
    operation: "include",
    name: "Inspection boundary",
    points: [
      { x: 492, y: 255 },
      { x: 822, y: 167 },
      { x: 1244, y: 190 },
      { x: 1482, y: 382 },
      { x: 1517, y: 720 },
      { x: 1301, y: 927 },
      { x: 896, y: 965 },
      { x: 552, y: 814 },
      { x: 455, y: 535 },
    ],
  },
  {
    id: "shape-opening",
    type: "ellipse",
    operation: "exclude",
    name: "Center opening",
    cx: 968,
    cy: 608,
    rx: 176,
    ry: 130,
  },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const safeInteger = (value: number, fallback = 1) =>
  Number.isFinite(value) ? Math.round(value) : fallback;

const slugify = (value: string) => {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "profile";
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const pointInPolygon = (point: Point, polygon: Point[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
};

const pointInShape = (point: Point, shape: RoiShape) => {
  if (shape.type === "polygon") return pointInPolygon(point, shape.points);
  const nx = (point.x - shape.cx) / Math.max(1, shape.rx);
  const ny = (point.y - shape.cy) / Math.max(1, shape.ry);
  return nx * nx + ny * ny <= 1;
};

const pointInValidRegion = (point: Point, shapes: RoiShape[]) => {
  const included = shapes
    .filter((shape) => shape.operation === "include")
    .some((shape) => pointInShape(point, shape));
  if (!included) return false;
  return !shapes
    .filter((shape) => shape.operation === "exclude")
    .some((shape) => pointInShape(point, shape));
};

const translateShape = (shape: RoiShape, dx: number, dy: number): RoiShape => {
  if (shape.type === "polygon") {
    return {
      ...shape,
      points: shape.points.map((point) => ({
        x: point.x + dx,
        y: point.y + dy,
      })),
    };
  }
  return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
};

const drawShapePath = (
  context: CanvasRenderingContext2D,
  shape: RoiShape,
) => {
  context.beginPath();
  if (shape.type === "polygon") {
    shape.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
  } else {
    context.ellipse(
      shape.cx,
      shape.cy,
      shape.rx,
      shape.ry,
      0,
      0,
      Math.PI * 2,
    );
  }
};

const canvasToBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not create the PNG file."));
    }, "image/png");
  });

export default function Home() {
  const [step, setStep] = useState<Step>("samples");
  const [profileName, setProfileName] = useState("luks_mini_pos1");
  const [samples, setSamples] = useState<SampleImage[]>([]);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [geometryMode, setGeometryMode] = useState<GeometryMode>("crop");
  const [cropGeometry, setCropGeometry] = useState<CropGeometry>({
    x: 549,
    y: 198,
    width: 768,
    height: 768,
  });
  const [annulusGeometry, setAnnulusGeometry] = useState<AnnulusGeometry>({
    cx: 968,
    cy: 608,
    innerRadius: 280,
    outerRadius: 450,
    stripHeight: 64,
    stripWidth: 2048,
  });
  const [regionMode, setRegionMode] = useState<RegionMode>("static");
  const [tool, setTool] = useState<DrawingTool>("select");
  const [operation, setOperation] = useState<Operation>("include");
  const [shapes, setShapes] = useState<RoiShape[]>(initialShapes);
  const [undoStack, setUndoStack] = useState<RoiShape[][]>([]);
  const [redoStack, setRedoStack] = useState<RoiShape[][]>([]);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(
    "shape-boundary",
  );
  const [draftPolygon, setDraftPolygon] = useState<Point[]>([]);
  const [ellipseStart, setEllipseStart] = useState<Point | null>(null);
  const [ellipseCurrent, setEllipseCurrent] = useState<Point | null>(null);
  const [dragState, setDragState] = useState<DragState>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(26);
  const [maskName, setMaskName] = useState("luks_mini_pos1_roi.png");
  const [dynamicMin, setDynamicMin] = useState(400);
  const [dynamicMax, setDynamicMax] = useState(510);
  const [inputHeight, setInputHeight] = useState(256);
  const [inputWidth, setInputWidth] = useState(256);
  const [tilingEnabled, setTilingEnabled] = useState(true);
  const [tileHeight, setTileHeight] = useState(128);
  const [tileWidth, setTileWidth] = useState(128);
  const [strideHeight, setStrideHeight] = useState(64);
  const [strideWidth, setStrideWidth] = useState(64);
  const [artifactEnabled, setArtifactEnabled] = useState(true);
  const [artifactWidth, setArtifactWidth] = useState(1024);
  const [artifactHeight, setArtifactHeight] = useState(1024);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const samplesRef = useRef<SampleImage[]>([]);

  const activeSample =
    samples.find((sample) => sample.id === activeSampleId) ?? samples[0] ?? null;
  const sourceWidth = activeSample?.width ?? DEFAULT_CANVAS_WIDTH;
  const sourceHeight = activeSample?.height ?? DEFAULT_CANVAS_HEIGHT;

  useEffect(() => {
    samplesRef.current = samples;
  }, [samples]);

  useEffect(() => {
    return () => {
      samplesRef.current.forEach((sample) => URL.revokeObjectURL(sample.url));
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("profile-studio-draft");
    if (!saved) return;
    try {
      const draft = JSON.parse(saved) as {
        profileName?: string;
        geometryMode?: GeometryMode;
        cropGeometry?: CropGeometry;
        annulusGeometry?: AnnulusGeometry;
        regionMode?: RegionMode;
        shapes?: RoiShape[];
        maskName?: string;
        inputHeight?: number;
        inputWidth?: number;
        tilingEnabled?: boolean;
        tileHeight?: number;
        tileWidth?: number;
        strideHeight?: number;
        strideWidth?: number;
        artifactEnabled?: boolean;
        artifactWidth?: number;
        artifactHeight?: number;
      };
      if (draft.profileName) setProfileName(draft.profileName);
      if (draft.geometryMode) setGeometryMode(draft.geometryMode);
      if (draft.cropGeometry) setCropGeometry(draft.cropGeometry);
      if (draft.annulusGeometry) setAnnulusGeometry(draft.annulusGeometry);
      if (draft.regionMode) setRegionMode(draft.regionMode);
      if (draft.shapes?.length) setShapes(draft.shapes);
      if (draft.maskName) setMaskName(draft.maskName);
      if (draft.inputHeight) setInputHeight(draft.inputHeight);
      if (draft.inputWidth) setInputWidth(draft.inputWidth);
      if (typeof draft.tilingEnabled === "boolean")
        setTilingEnabled(draft.tilingEnabled);
      if (draft.tileHeight) setTileHeight(draft.tileHeight);
      if (draft.tileWidth) setTileWidth(draft.tileWidth);
      if (draft.strideHeight) setStrideHeight(draft.strideHeight);
      if (draft.strideWidth) setStrideWidth(draft.strideWidth);
      if (typeof draft.artifactEnabled === "boolean")
        setArtifactEnabled(draft.artifactEnabled);
      if (draft.artifactWidth) setArtifactWidth(draft.artifactWidth);
      if (draft.artifactHeight) setArtifactHeight(draft.artifactHeight);
    } catch {
      window.localStorage.removeItem("profile-studio-draft");
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(
        "profile-studio-draft",
        JSON.stringify({
          profileName,
          geometryMode,
          cropGeometry,
          annulusGeometry,
          regionMode,
          shapes,
          maskName,
          inputHeight,
          inputWidth,
          tilingEnabled,
          tileHeight,
          tileWidth,
          strideHeight,
          strideWidth,
          artifactEnabled,
          artifactWidth,
          artifactHeight,
        }),
      );
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [
    profileName,
    geometryMode,
    cropGeometry,
    annulusGeometry,
    regionMode,
    shapes,
    maskName,
    inputHeight,
    inputWidth,
    tilingEnabled,
    tileHeight,
    tileWidth,
    strideHeight,
    strideWidth,
    artifactEnabled,
    artifactWidth,
    artifactHeight,
  ]);

  const updateShapes = (next: RoiShape[]) => {
    setUndoStack((history) => [...history.slice(-39), shapes]);
    setRedoStack([]);
    setShapes(next);
  };

  const undo = () => {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((history) => [shapes, ...history.slice(0, 39)]);
    setShapes(previous);
    setUndoStack((history) => history.slice(0, -1));
    setSelectedShapeId(null);
  };

  const redo = () => {
    const next = redoStack[0];
    if (!next) return;
    setUndoStack((history) => [...history.slice(-39), shapes]);
    setShapes(next);
    setRedoStack((history) => history.slice(1));
    setSelectedShapeId(null);
  };

  const finishPolygon = () => {
    if (draftPolygon.length < 3) return;
    const nextShape: PolygonShape = {
      id: crypto.randomUUID(),
      type: "polygon",
      operation,
      name: `${operation === "include" ? "Inspection area" : "Excluded area"} ${shapes.length + 1}`,
      points: draftPolygon,
    };
    updateShapes([...shapes, nextShape]);
    setDraftPolygon([]);
    setSelectedShapeId(nextShape.id);
    setTool("select");
  };

  const getCanvasPoint = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(
        ((event.clientX - bounds.left) / bounds.width) * sourceWidth,
        0,
        sourceWidth,
      ),
      y: clamp(
        ((event.clientY - bounds.top) / bounds.height) * sourceHeight,
        0,
        sourceHeight,
      ),
    };
  };

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    if (event.button !== 0) return;
    const point = getCanvasPoint(event);

    if (step === "geometry" && geometryMode === "crop") {
      const inside =
        point.x >= cropGeometry.x &&
        point.x <= cropGeometry.x + cropGeometry.width &&
        point.y >= cropGeometry.y &&
        point.y <= cropGeometry.y + cropGeometry.height;
      if (inside) {
        setDragState({
          kind: "crop",
          start: point,
          original: cropGeometry,
        });
      }
      return;
    }

    if (step === "geometry" && geometryMode === "annulus") {
      const distance = Math.hypot(
        point.x - annulusGeometry.cx,
        point.y - annulusGeometry.cy,
      );
      if (distance <= annulusGeometry.outerRadius) {
        setDragState({
          kind: "annulus",
          start: point,
          original: annulusGeometry,
        });
      }
      return;
    }

    if (step !== "region" || regionMode !== "static") return;

    if (tool === "polygon") {
      setDraftPolygon((points) => [...points, point]);
      return;
    }

    if (tool === "ellipse") {
      setEllipseStart(point);
      setEllipseCurrent(point);
      return;
    }

    if (tool === "select") {
      setSelectedShapeId(null);
    }
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    const point = getCanvasPoint(event);

    if (ellipseStart) {
      setEllipseCurrent(point);
      return;
    }

    if (!dragState) return;
    const dx = point.x - dragState.start.x;
    const dy = point.y - dragState.start.y;

    if (dragState.kind === "crop") {
      setCropGeometry({
        ...dragState.original,
        x: safeInteger(
          clamp(
            dragState.original.x + dx,
            0,
            sourceWidth - dragState.original.width,
          ),
        ),
        y: safeInteger(
          clamp(
            dragState.original.y + dy,
            0,
            sourceHeight - dragState.original.height,
          ),
        ),
      });
      return;
    }

    if (dragState.kind === "annulus") {
      setAnnulusGeometry({
        ...dragState.original,
        cx: safeInteger(
          clamp(
            dragState.original.cx + dx,
            dragState.original.outerRadius,
            sourceWidth - dragState.original.outerRadius,
          ),
        ),
        cy: safeInteger(
          clamp(
            dragState.original.cy + dy,
            dragState.original.outerRadius,
            sourceHeight - dragState.original.outerRadius,
          ),
        ),
      });
      return;
    }

    setShapes((current) =>
      current.map((shape) =>
        shape.id === dragState.shapeId
          ? translateShape(dragState.original, dx, dy)
          : shape,
      ),
    );
  };

  const handleCanvasPointerUp = () => {
    if (ellipseStart && ellipseCurrent) {
      const cx = (ellipseStart.x + ellipseCurrent.x) / 2;
      const cy = (ellipseStart.y + ellipseCurrent.y) / 2;
      const rx = Math.abs(ellipseCurrent.x - ellipseStart.x) / 2;
      const ry = Math.abs(ellipseCurrent.y - ellipseStart.y) / 2;
      if (rx > 3 && ry > 3) {
        const nextShape: EllipseShape = {
          id: crypto.randomUUID(),
          type: "ellipse",
          operation,
          name: `${operation === "include" ? "Inspection ellipse" : "Excluded ellipse"} ${shapes.length + 1}`,
          cx,
          cy,
          rx,
          ry,
        };
        updateShapes([...shapes, nextShape]);
        setSelectedShapeId(nextShape.id);
      }
      setEllipseStart(null);
      setEllipseCurrent(null);
      setTool("select");
      return;
    }

    if (dragState?.kind === "shape") {
      setUndoStack((history) => [
        ...history.slice(-39),
        shapes.map((shape) =>
          shape.id === dragState.shapeId ? dragState.original : shape,
        ),
      ]);
      setRedoStack([]);
    }
    setDragState(null);
  };

  const startShapeDrag = (
    event: ReactPointerEvent<SVGElement>,
    shape: RoiShape,
  ) => {
    if (tool !== "select" || step !== "region") return;
    event.stopPropagation();
    setSelectedShapeId(shape.id);
    const svg = svgRef.current;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const start = {
      x: ((event.clientX - bounds.left) / bounds.width) * sourceWidth,
      y: ((event.clientY - bounds.top) / bounds.height) * sourceHeight,
    };
    setDragState({ kind: "shape", shapeId: shape.id, start, original: shape });
  };

  const removeShape = (shapeId: string) => {
    updateShapes(shapes.filter((shape) => shape.id !== shapeId));
    if (selectedShapeId === shapeId) setSelectedShapeId(null);
  };

  const removeSample = (sampleId: string) => {
    const index = samples.findIndex((sample) => sample.id === sampleId);
    if (index === -1) return;

    const removed = samples[index];
    const remaining = samples.filter((sample) => sample.id !== sampleId);
    URL.revokeObjectURL(removed.url);
    setSamples(remaining);

    if (activeSample?.id === sampleId) {
      const nextActive = remaining[index] ?? remaining[index - 1] ?? null;
      setActiveSampleId(nextActive?.id ?? null);
    }

    setNotice(`${removed.name} removed.`);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    const loaded = await Promise.all(
      files.map(
        (file) =>
          new Promise<SampleImage>((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () =>
              resolve({
                id: crypto.randomUUID(),
                name: file.name,
                url,
                width: image.naturalWidth,
                height: image.naturalHeight,
                bytes: file.size,
              });
            image.onerror = () => {
              URL.revokeObjectURL(url);
              reject(new Error(`Could not read ${file.name}`));
            };
            image.src = url;
          }),
      ),
    );

    const first = loaded[0];
    const expected = samples[0] ?? first;
    const dimensionsMatch = loaded.every(
      (sample) =>
        sample.width === expected.width && sample.height === expected.height,
    );
    if (!dimensionsMatch) {
      loaded.forEach((sample) => URL.revokeObjectURL(sample.url));
      setNotice(
        `All reference images must be ${expected.width} × ${expected.height}.`,
      );
      event.target.value = "";
      return;
    }

    setSamples((current) => [...current, ...loaded]);
    setActiveSampleId(first.id);
    if (!samples.length) {
      const cropWidth = Math.max(1, Math.round(first.width * 0.62));
      const cropHeight = Math.max(1, Math.round(first.height * 0.72));
      setCropGeometry({
        x: Math.round((first.width - cropWidth) / 2),
        y: Math.round((first.height - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      });
      const outerRadius = Math.round(Math.min(first.width, first.height) * 0.36);
      setAnnulusGeometry((value) => ({
        ...value,
        cx: Math.round(first.width / 2),
        cy: Math.round(first.height / 2),
        innerRadius: Math.round(outerRadius * 0.62),
        outerRadius,
      }));
      setShapes([]);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedShapeId(null);
    }
    setNotice(`${loaded.length} reference image${loaded.length === 1 ? "" : "s"} added.`);
    event.target.value = "";
  };

  const handleImportProfile = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      if (typeof data.name === "string") setProfileName(data.name);
      if (
        Array.isArray(data.input_size) &&
        data.input_size.length === 2
      ) {
        setInputHeight(Number(data.input_size[0]));
        setInputWidth(Number(data.input_size[1]));
      }

      const preprocess = Array.isArray(data.preprocess_steps)
        ? (data.preprocess_steps as Array<Record<string, unknown>>)
        : [];
      const firstStep = preprocess[0];
      if (firstStep?.name === "crop") {
        const params = firstStep.params as Record<string, unknown>;
        setGeometryMode("crop");
        setCropGeometry({
          x: Number(params.x),
          y: Number(params.y),
          width: Number(params.width),
          height: Number(params.height),
        });
      } else if (firstStep?.name === "annulus_unwrap") {
        const params = firstStep.params as Record<string, unknown>;
        const center = params.center as number[];
        const stripSize = params.strip_size as number[];
        setGeometryMode("annulus");
        setAnnulusGeometry({
          cx: Number(center?.[0]),
          cy: Number(center?.[1]),
          innerRadius: Number(params.inner_radius),
          outerRadius: Number(params.outer_radius),
          stripHeight: Number(stripSize?.[0]),
          stripWidth: Number(stripSize?.[1]),
        });
      } else {
        setGeometryMode("full");
      }

      const validRegion = data.valid_region as
        | Record<string, unknown>
        | undefined;
      if (!validRegion) setRegionMode("none");
      else if (validRegion.type === "ellipse") {
        setRegionMode("dynamic");
        const range = validRegion.diameter_range as number[];
        setDynamicMin(Number(range?.[0]));
        setDynamicMax(Number(range?.[1]));
      } else {
        setRegionMode("static");
        if (typeof validRegion.path === "string")
          setMaskName(validRegion.path);
      }

      const tiling = data.tiling as Record<string, unknown> | undefined;
      setTilingEnabled(Boolean(tiling));
      if (tiling) {
        const tileSize = tiling.tile_size as number[];
        const stride = tiling.stride as number[];
        setTileHeight(Number(tileSize?.[0]));
        setTileWidth(Number(tileSize?.[1]));
        setStrideHeight(Number(stride?.[0]));
        setStrideWidth(Number(stride?.[1]));
      }

      const artifact = data.artifact_size as
        | Record<string, unknown>
        | undefined;
      setArtifactEnabled(Boolean(artifact));
      if (artifact) {
        setArtifactWidth(Number(artifact.max_width ?? 1024));
        setArtifactHeight(Number(artifact.max_height ?? 1024));
      }
      setNotice(`Imported ${file.name}.`);
      setStep("review");
    } catch {
      setNotice("That file is not a valid profile JSON.");
    }
    event.target.value = "";
  };

  const processedRect = useMemo(() => {
    if (geometryMode === "crop") return cropGeometry;
    if (geometryMode === "annulus") {
      return {
        x: annulusGeometry.cx - annulusGeometry.outerRadius,
        y: annulusGeometry.cy - annulusGeometry.outerRadius,
        width: annulusGeometry.outerRadius * 2,
        height: annulusGeometry.outerRadius * 2,
      };
    }
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }, [
    geometryMode,
    cropGeometry,
    annulusGeometry,
    sourceWidth,
    sourceHeight,
  ]);

  const tilingTiles = useMemo(() => {
    if (
      !tilingEnabled ||
      tileHeight <= 0 ||
      tileWidth <= 0 ||
      strideHeight <= 0 ||
      strideWidth <= 0 ||
      inputHeight <= 0 ||
      inputWidth <= 0
    ) {
      return [];
    }

    const rows = Math.max(
      1,
      Math.ceil(Math.max(0, inputHeight - tileHeight) / strideHeight) + 1,
    );
    const columns = Math.max(
      1,
      Math.ceil(Math.max(0, inputWidth - tileWidth) / strideWidth) + 1,
    );
    const scaleX = processedRect.width / inputWidth;
    const scaleY = processedRect.height / inputHeight;
    const tiles = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const modelX = column * strideWidth;
        const modelY = row * strideHeight;
        const x = processedRect.x + modelX * scaleX;
        const y = processedRect.y + modelY * scaleY;
        const width = tileWidth * scaleX;
        const height = tileHeight * scaleY;
        let valid = 0;
        const checks = 25;
        for (let sy = 0; sy < 5; sy += 1) {
          for (let sx = 0; sx < 5; sx += 1) {
            const point = {
              x: x + ((sx + 0.5) / 5) * width,
              y: y + ((sy + 0.5) / 5) * height,
            };
            const isValid =
              regionMode === "none" ||
              regionMode === "dynamic" ||
              pointInValidRegion(point, shapes);
            if (isValid) valid += 1;
          }
        }
        tiles.push({
          id: row * columns + column + 1,
          x,
          y,
          width,
          height,
          included: valid / checks >= 0.3,
          coverage: valid / checks,
        });
      }
    }
    return tiles;
  }, [
    tilingEnabled,
    tileHeight,
    tileWidth,
    strideHeight,
    strideWidth,
    inputHeight,
    inputWidth,
    processedRect,
    regionMode,
    shapes,
  ]);

  const validation = useMemo(() => {
    const checks: Array<{ ok: boolean; label: string }> = [];
    checks.push({
      ok:
        profileName.trim().length > 0 &&
        !profileName.includes("/") &&
        !profileName.includes("\\"),
      label: "Profile name and filename match",
    });
    checks.push({
      ok:
        samples.length > 0 &&
        samples.every(
          (sample) =>
            sample.width === sourceWidth && sample.height === sourceHeight,
        ),
      label:
        samples.length === 0
          ? "Add at least one reference image"
          : `${samples.length} reference sample${samples.length === 1 ? "" : "s"} aligned`,
    });
    checks.push({
      ok:
        geometryMode === "full" ||
        (geometryMode === "crop"
          ? cropGeometry.x >= 0 &&
            cropGeometry.y >= 0 &&
            cropGeometry.width > 0 &&
            cropGeometry.height > 0 &&
            cropGeometry.x + cropGeometry.width <= sourceWidth &&
            cropGeometry.y + cropGeometry.height <= sourceHeight
          : annulusGeometry.innerRadius > 0 &&
            annulusGeometry.outerRadius > annulusGeometry.innerRadius &&
            annulusGeometry.cx - annulusGeometry.outerRadius >= 0 &&
            annulusGeometry.cy - annulusGeometry.outerRadius >= 0 &&
            annulusGeometry.cx + annulusGeometry.outerRadius <= sourceWidth &&
            annulusGeometry.cy + annulusGeometry.outerRadius <= sourceHeight &&
            annulusGeometry.stripHeight > 0 &&
            annulusGeometry.stripWidth > 0),
      label:
        geometryMode === "crop"
          ? "Crop and restoration geometry match"
          : geometryMode === "annulus"
            ? "Annulus unwrap and wrap geometry match"
            : "Full image geometry selected",
    });
    checks.push({
      ok:
        regionMode === "none" ||
        (regionMode === "static"
          ? shapes.some((shape) => shape.operation === "include") &&
            maskName.trim().length > 0 &&
            !maskName.includes("/") &&
            !maskName.includes("\\") &&
            maskName.toLowerCase().endsWith(".png")
          : dynamicMin > 0 && dynamicMax > dynamicMin),
      label:
        regionMode === "static"
          ? "Valid-region mask contains an included area"
          : regionMode === "dynamic"
            ? "Dynamic ellipse diameter range is valid"
            : "Entire processed image is valid",
    });
    checks.push({
      ok:
        inputHeight > 0 &&
        inputWidth > 0 &&
        (!tilingEnabled ||
          (tileHeight > 0 &&
            tileWidth > 0 &&
            strideHeight > 0 &&
            strideWidth > 0 &&
            tileHeight <= inputHeight &&
            tileWidth <= inputWidth &&
            strideHeight <= tileHeight &&
            strideWidth <= tileWidth &&
            tilingTiles.some((tile) => tile.included))) &&
        (!artifactEnabled ||
          (artifactWidth > 0 && artifactHeight > 0)),
      label: tilingEnabled
        ? `${tilingTiles.filter((tile) => tile.included).length} of ${tilingTiles.length} tiles included`
        : "Model input size is valid",
    });
    return checks;
  }, [
    profileName,
    samples,
    sourceWidth,
    sourceHeight,
    geometryMode,
    cropGeometry,
    annulusGeometry,
    regionMode,
    shapes,
    maskName,
    dynamicMin,
    dynamicMax,
    inputHeight,
    inputWidth,
    tilingEnabled,
    tileHeight,
    tileWidth,
    strideHeight,
    strideWidth,
    tilingTiles,
    artifactEnabled,
    artifactWidth,
    artifactHeight,
  ]);

  const profile = useMemo(() => {
    const output: Record<string, unknown> = {
      name: slugify(profileName),
      preprocess_steps: [],
      postprocess_steps: [],
      input_size: [safeInteger(inputHeight), safeInteger(inputWidth)],
    };

    if (geometryMode === "crop") {
      output.preprocess_steps = [
        {
          name: "crop",
          params: {
            x: safeInteger(cropGeometry.x),
            y: safeInteger(cropGeometry.y),
            width: safeInteger(cropGeometry.width),
            height: safeInteger(cropGeometry.height),
          },
        },
      ];
      output.postprocess_steps = [
        {
          name: "crop_restore",
          params: {
            image_size: [sourceHeight, sourceWidth],
            x: safeInteger(cropGeometry.x),
            y: safeInteger(cropGeometry.y),
            width: safeInteger(cropGeometry.width),
            height: safeInteger(cropGeometry.height),
          },
        },
      ];
    } else if (geometryMode === "annulus") {
      const geometry = {
        center: [safeInteger(annulusGeometry.cx), safeInteger(annulusGeometry.cy)],
        inner_radius: safeInteger(annulusGeometry.innerRadius),
        outer_radius: safeInteger(annulusGeometry.outerRadius),
      };
      output.preprocess_steps = [
        {
          name: "annulus_unwrap",
          params: {
            ...geometry,
            strip_size: [
              safeInteger(annulusGeometry.stripHeight),
              safeInteger(annulusGeometry.stripWidth),
            ],
          },
        },
      ];
      output.postprocess_steps = [
        {
          name: "annulus_wrap",
          params: {
            ...geometry,
            image_size: [sourceHeight, sourceWidth],
          },
        },
      ];
    }

    if (regionMode === "static") {
      output.valid_region = {
        type: "mask",
        path: maskName.trim() || `${slugify(profileName)}_roi.png`,
      };
    } else if (regionMode === "dynamic") {
      output.valid_region = {
        type: "ellipse",
        diameter_range: [safeInteger(dynamicMin), safeInteger(dynamicMax)],
      };
    }

    if (tilingEnabled) {
      output.tiling = {
        tile_size: [safeInteger(tileHeight), safeInteger(tileWidth)],
        stride: [safeInteger(strideHeight), safeInteger(strideWidth)],
      };
    }

    if (artifactEnabled) {
      output.artifact_size = {
        max_width: safeInteger(artifactWidth),
        max_height: safeInteger(artifactHeight),
      };
    }
    return output;
  }, [
    profileName,
    geometryMode,
    cropGeometry,
    annulusGeometry,
    sourceHeight,
    sourceWidth,
    inputHeight,
    inputWidth,
    regionMode,
    maskName,
    dynamicMin,
    dynamicMax,
    tilingEnabled,
    tileHeight,
    tileWidth,
    strideHeight,
    strideWidth,
    artifactEnabled,
    artifactWidth,
    artifactHeight,
  ]);

  const drawMask = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.fillStyle = "#000";
    context.fillRect(0, 0, sourceWidth, sourceHeight);
    shapes
      .filter((shape) => shape.operation === "include")
      .forEach((shape) => {
        drawShapePath(context, shape);
        context.fillStyle = "#fff";
        context.fill();
      });
    shapes
      .filter((shape) => shape.operation === "exclude")
      .forEach((shape) => {
        drawShapePath(context, shape);
        context.fillStyle = "#000";
        context.fill();
      });
    return canvasToBlob(canvas);
  };

  const drawPreview = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    if (activeSample) {
      const image = new Image();
      image.src = activeSample.url;
      await image.decode();
      context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
    } else {
      throw new Error("Add a reference image before creating a preview.");
    }
    shapes.forEach((shape) => {
      drawShapePath(context, shape);
      context.fillStyle =
        shape.operation === "include"
          ? "rgba(68, 110, 87, 0.30)"
          : "rgba(182, 77, 67, 0.35)";
      context.fill();
      context.strokeStyle =
        shape.operation === "include" ? "#446e57" : "#b64d43";
      context.lineWidth = Math.max(2, sourceWidth / 500);
      context.stroke();
    });
    return canvasToBlob(canvas);
  };

  const exportBundle = async () => {
    if (validation.some((check) => !check.ok)) {
      setNotice("Resolve the blocking issues before exporting.");
      setStep("review");
      return;
    }
    setExporting(true);
    try {
      const zip = new JSZip();
      const resolvedProfileName = slugify(profileName);
      const resolvedMaskName =
        maskName.trim() || `${resolvedProfileName}_roi.png`;
      zip.file(
        `profiles/${resolvedProfileName}.json`,
        `${JSON.stringify(profile, null, 2)}\n`,
      );

      if (regionMode === "static") {
        zip.file(`dataset/valid_regions/${resolvedMaskName}`, await drawMask());
        zip.file(
          "previews/valid-region-overlay.png",
          await drawPreview(),
        );
      }

      zip.file(
        "builder-project.json",
        `${JSON.stringify(
          {
            builder: "Profile Studio",
            version: 1,
            source_size: [sourceHeight, sourceWidth],
            geometry: {
              mode: geometryMode,
              crop: cropGeometry,
              annulus: annulusGeometry,
            },
            valid_region: {
              mode: regionMode,
              shapes,
              dynamic_diameter_range: [dynamicMin, dynamicMax],
            },
            profile,
          },
          null,
          2,
        )}\n`,
      );
      zip.file(
        "manifest.json",
        `${JSON.stringify(
          {
            generated_by: "Profile Studio",
            profile: `profiles/${resolvedProfileName}.json`,
            valid_region:
              regionMode === "static"
                ? `dataset/valid_regions/${resolvedMaskName}`
                : null,
            source_dimensions: {
              width: sourceWidth,
              height: sourceHeight,
            },
            samples: samples.map((sample) => sample.name),
          },
          null,
          2,
        )}\n`,
      );
      zip.file(
        "README.txt",
        [
          "PROFILE STUDIO EXPORT",
          "",
          `Copy profiles/${resolvedProfileName}.json into PROFILES_ROOT.`,
          regionMode === "static"
            ? `Copy dataset/valid_regions/${resolvedMaskName} into the dataset's valid_regions directory.`
            : "This profile does not require a static mask file.",
          "",
          "Keep the JSON filename identical to the profile name.",
        ].join("\n"),
      );

      const bundle = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(bundle);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${resolvedProfileName}-profile.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Profile bundle exported.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not export the bundle.",
      );
    } finally {
      setExporting(false);
    }
  };

  const resetDraft = () => {
    setProfileName("luks_mini_pos1");
    setGeometryMode("crop");
    setCropGeometry({ x: 549, y: 198, width: 768, height: 768 });
    setRegionMode("static");
    setShapes(initialShapes);
    setMaskName("luks_mini_pos1_roi.png");
    setInputHeight(256);
    setInputWidth(256);
    setTilingEnabled(true);
    setTileHeight(128);
    setTileWidth(128);
    setStrideHeight(64);
    setStrideWidth(64);
    setArtifactEnabled(true);
    setStep("region");
    setNotice("Draft reset to the example profile.");
  };

  const selectedShape = shapes.find((shape) => shape.id === selectedShapeId);
  const activeTiles = tilingTiles.filter((tile) => tile.included);
  const stepNumber = STEPS.findIndex((item) => item.id === step) + 1;

  const canvasCopy: Record<
    Step,
    { eyebrow: string; title: string; meta: string }
  > = {
    samples: {
      eyebrow: "REFERENCE IMAGES",
      title: "Check the profile across representative samples",
      meta: "All images in one profile must share source dimensions and alignment.",
    },
    geometry: {
      eyebrow: `GEOMETRY · ${geometryMode.toUpperCase()}`,
      title:
        geometryMode === "crop"
          ? "Position the crop around the inspected part"
          : geometryMode === "annulus"
            ? "Align the inner and outer annulus boundaries"
            : "Use the complete source image",
      meta: "Drag the active geometry or enter exact source-image coordinates.",
    },
    region: {
      eyebrow:
        regionMode === "static"
          ? "VALID REGION · STATIC MASK"
          : regionMode === "dynamic"
            ? "VALID REGION · DYNAMIC ELLIPSE"
            : "VALID REGION · FULL AREA",
      title:
        regionMode === "static"
          ? "Draw the area the model should inspect"
          : regionMode === "dynamic"
            ? "Set the acceptable detected ellipse diameter"
            : "The entire processed image will be inspected",
      meta: `Coordinates are stored in the original ${sourceWidth} × ${sourceHeight} image space.`,
    },
    model: {
      eyebrow: "MODEL INPUT · TILING",
      title: "Preview how the model divides the valid region",
      meta: "Tiles with at least 30% valid pixels are included.",
    },
    review: {
      eyebrow: "REVIEW",
      title: "Verify the effective training profile",
      meta: "The JSON and mask below are the files included in the export bundle.",
    },
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            PS
          </div>
          <div>
            <div className="brand-name">Profile Studio</div>
            <div className="draft-status">
              {slugify(profileName)} <span>·</span> Draft saved locally
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={handleImportProfile}
          />
          <button
            className="button button-secondary"
            type="button"
            onClick={() => importInputRef.current?.click()}
          >
            <FileJson size={16} />
            Import profile
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={() => setStep("review")}
          >
            Review &amp; export
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <nav className="stepper" aria-label="Profile setup">
        {STEPS.map((item, index) => {
          const isActive = item.id === step;
          const isComplete = index < stepNumber - 1;
          return (
            <button
              type="button"
              key={item.id}
              className={`step-button ${isActive ? "active" : ""}`}
              onClick={() => setStep(item.id)}
            >
              <span className="step-index">
                {isComplete ? <Check size={13} /> : index + 1}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div className="workspace">
        <section className="editor-card">
          <div className="editor-header">
            <div>
              <div className="eyebrow">{canvasCopy[step].eyebrow}</div>
              <h1>{canvasCopy[step].title}</h1>
              <p>{canvasCopy[step].meta}</p>
            </div>
            {step === "region" && regionMode === "static" && (
              <div className="drawing-toolbar" aria-label="Drawing tools">
                {[
                  {
                    id: "select" as const,
                    label: "Select",
                    icon: MousePointer2,
                  },
                  {
                    id: "polygon" as const,
                    label: "Polygon",
                    icon: Hexagon,
                  },
                  {
                    id: "ellipse" as const,
                    label: "Ellipse",
                    icon: Circle,
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      className={`tool-button ${tool === item.id ? "active" : ""}`}
                      type="button"
                      key={item.id}
                      onClick={() => {
                        if (draftPolygon.length >= 3 && item.id !== "polygon")
                          finishPolygon();
                        setTool(item.id);
                      }}
                    >
                      <Icon size={16} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div
            className={`image-stage ${tool !== "select" && step === "region" ? "drawing" : ""}`}
            style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
          >
            {activeSample ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeSample.url}
                alt={`Reference sample ${activeSample.name}`}
              />
            ) : (
              <div className="image-empty-state" role="status">
                <ImageIcon size={42} strokeWidth={1.5} aria-hidden="true" />
                <strong>No image</strong>
                <span>Upload a reference image to get started</span>
              </div>
            )}

            {activeSample && (
              <svg
                ref={svgRef}
                className="interaction-layer"
                viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
                preserveAspectRatio="none"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerLeave={handleCanvasPointerUp}
                onDoubleClick={() => {
                  if (tool === "polygon") finishPolygon();
                }}
              >
              {(step === "geometry" || step === "review") &&
                geometryMode === "crop" && (
                  <g className="crop-overlay">
                    <path
                      d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${cropGeometry.x} ${cropGeometry.y}H${cropGeometry.x + cropGeometry.width}V${cropGeometry.y + cropGeometry.height}H${cropGeometry.x}Z`}
                      fillRule="evenodd"
                    />
                    <rect
                      x={cropGeometry.x}
                      y={cropGeometry.y}
                      width={cropGeometry.width}
                      height={cropGeometry.height}
                      className="geometry-line"
                    />
                    {[
                      [cropGeometry.x, cropGeometry.y],
                      [
                        cropGeometry.x + cropGeometry.width,
                        cropGeometry.y,
                      ],
                      [
                        cropGeometry.x,
                        cropGeometry.y + cropGeometry.height,
                      ],
                      [
                        cropGeometry.x + cropGeometry.width,
                        cropGeometry.y + cropGeometry.height,
                      ],
                    ].map(([x, y], index) => (
                      <circle
                        key={index}
                        cx={x}
                        cy={y}
                        r={Math.max(sourceWidth, sourceHeight) * 0.009}
                        className="geometry-handle"
                      />
                    ))}
                  </g>
                )}

              {(step === "geometry" || step === "review") &&
                geometryMode === "annulus" && (
                  <g className="annulus-overlay">
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.outerRadius}
                      className="annulus-fill"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.outerRadius}
                      className="geometry-line"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.innerRadius}
                      className="geometry-line inner"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={Math.max(sourceWidth, sourceHeight) * 0.009}
                      className="geometry-handle"
                    />
                  </g>
                )}

              {(step === "region" ||
                step === "model" ||
                step === "review") &&
                regionMode === "static" && (
                  <g
                    className="roi-shapes"
                    style={{ opacity: overlayOpacity / 100 + 0.35 }}
                  >
                    {shapes.map((shape) => {
                      const className = [
                        "roi-shape",
                        shape.operation,
                        selectedShapeId === shape.id ? "selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      if (shape.type === "polygon") {
                        return (
                          <g key={shape.id}>
                            <polygon
                              points={shape.points
                                .map((point) => `${point.x},${point.y}`)
                                .join(" ")}
                              className={className}
                              onPointerDown={(event) =>
                                startShapeDrag(event, shape)
                              }
                            />
                            {selectedShapeId === shape.id &&
                              shape.points.map((point, index) => (
                                <circle
                                  key={index}
                                  cx={point.x}
                                  cy={point.y}
                                  r={
                                    Math.max(sourceWidth, sourceHeight) * 0.007
                                  }
                                  className="roi-handle"
                                />
                              ))}
                          </g>
                        );
                      }
                      return (
                        <ellipse
                          key={shape.id}
                          cx={shape.cx}
                          cy={shape.cy}
                          rx={shape.rx}
                          ry={shape.ry}
                          className={className}
                          onPointerDown={(event) =>
                            startShapeDrag(event, shape)
                          }
                        />
                      );
                    })}

                    {draftPolygon.length > 0 && (
                      <g>
                        <polyline
                          points={draftPolygon
                            .map((point) => `${point.x},${point.y}`)
                            .join(" ")}
                          className="draft-shape"
                        />
                        {draftPolygon.map((point, index) => (
                          <circle
                            key={index}
                            cx={point.x}
                            cy={point.y}
                            r={Math.max(sourceWidth, sourceHeight) * 0.007}
                            className="roi-handle"
                          />
                        ))}
                      </g>
                    )}

                    {ellipseStart && ellipseCurrent && (
                      <ellipse
                        cx={(ellipseStart.x + ellipseCurrent.x) / 2}
                        cy={(ellipseStart.y + ellipseCurrent.y) / 2}
                        rx={Math.abs(ellipseCurrent.x - ellipseStart.x) / 2}
                        ry={Math.abs(ellipseCurrent.y - ellipseStart.y) / 2}
                        className={`roi-shape ${operation}`}
                      />
                    )}
                  </g>
                )}

              {(step === "model" || step === "review") &&
                tilingEnabled && (
                  <g className="tiling-overlay">
                    {tilingTiles.map((tile) => (
                      <g key={tile.id}>
                        <rect
                          x={tile.x}
                          y={tile.y}
                          width={tile.width}
                          height={tile.height}
                          className={`tile ${tile.included ? "included" : "skipped"}`}
                        />
                        <text
                          x={tile.x + tile.width / 2}
                          y={tile.y + tile.height / 2}
                          className="tile-label"
                        >
                          {tile.id}
                        </text>
                      </g>
                    ))}
                  </g>
                )}

              {step === "region" && regionMode === "dynamic" && (
                <g className="dynamic-ellipse">
                  <ellipse
                    cx={sourceWidth / 2}
                    cy={sourceHeight / 2}
                    rx={dynamicMax / 2}
                    ry={dynamicMax / 2}
                    className="dynamic-max"
                  />
                  <ellipse
                    cx={sourceWidth / 2}
                    cy={sourceHeight / 2}
                    rx={dynamicMin / 2}
                    ry={dynamicMin / 2}
                    className="dynamic-min"
                  />
                </g>
              )}
              </svg>
            )}

            <div className="stage-label">
              {activeSample ? (
                <>
                  {activeSample.name}
                  <span>
                    {sourceWidth} × {sourceHeight}
                  </span>
                </>
              ) : (
                "No image"
              )}
            </div>
          </div>

          <div className="editor-footer">
            <div className="sample-switcher">
              {samples.length ? (
                samples.map((sample, index) => (
                  <button
                    key={sample.id}
                    type="button"
                    className={`sample-pill ${
                      sample.id === activeSample?.id ? "active" : ""
                    }`}
                    onClick={() => setActiveSampleId(sample.id)}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </button>
                ))
              ) : (
                <ImageIcon size={16} aria-hidden="true" />
              )}
              <span>
                {samples.length
                  ? `${samples.length} aligned sample${samples.length === 1 ? "" : "s"}`
                  : "No reference images"}
              </span>
            </div>
            <div className="canvas-status">
              {step === "model"
                ? `${activeTiles.length} included · ${Math.max(0, tilingTiles.length - activeTiles.length)} skipped`
                : step === "region" && regionMode === "static"
                  ? `${shapes.length} shape${shapes.length === 1 ? "" : "s"} · source-space mask`
                  : step === "geometry" && geometryMode === "crop"
                    ? `${cropGeometry.width} × ${cropGeometry.height} crop`
                    : `${validation.filter((check) => check.ok).length} of ${validation.length} checks passed`}
            </div>
          </div>
        </section>

        <aside className="settings-card">
          <div className="settings-header">
            <div className="eyebrow">
              STEP {stepNumber} OF {STEPS.length}
            </div>
            <h2>{STEPS[stepNumber - 1].label}</h2>
          </div>

          {step === "samples" && (
            <div className="settings-content">
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/png,image/jpeg,image/bmp,image/webp,image/tiff"
                multiple
                hidden
                onChange={handleUpload}
              />
              <button
                type="button"
                className="upload-zone"
                onClick={() => uploadInputRef.current?.click()}
              >
                <div className="upload-icon">
                  <Upload size={20} />
                </div>
                <strong>Add reference images</strong>
                <span>Select one or more · PNG, JPG, BMP, WebP or TIFF</span>
              </button>

              <div className="section-block">
                <div className="section-label">REFERENCE IMAGES</div>
                <div className="sample-list">
                  {samples.length ? (
                    samples.map((sample) => (
                      <div
                        className={`sample-row ${
                          sample.id === activeSample?.id ? "active" : ""
                        }`}
                        key={sample.id}
                      >
                        <button
                          type="button"
                          className="sample-main"
                          onClick={() => setActiveSampleId(sample.id)}
                        >
                          <span className="sample-row-icon">
                            <ImageIcon size={15} />
                          </span>
                          <span className="sample-row-copy">
                            <strong>{sample.name}</strong>
                            <span>
                              {sample.width} × {sample.height} ·{" "}
                              {formatBytes(sample.bytes)}
                            </span>
                          </span>
                          <Check size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          aria-label={`Remove ${sample.name}`}
                          onClick={() => removeSample(sample.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state">
                      No reference images uploaded yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="panel-footer">
                <div className="footer-status success">
                  {samples.length ? <Check size={15} /> : <ImageIcon size={15} />}
                  {samples.length ? "All dimensions match" : "No images"}
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => setStep("geometry")}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          {step === "geometry" && (
            <div className="settings-content">
              <div className="field-group">
                <label className="field-label">Preprocessing geometry</label>
                <div className="segmented-control three">
                  {[
                    { id: "full" as const, label: "Full", icon: Maximize2 },
                    { id: "crop" as const, label: "Crop", icon: Crop },
                    { id: "annulus" as const, label: "Annulus", icon: Circle },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={
                          geometryMode === item.id ? "active" : undefined
                        }
                        onClick={() => setGeometryMode(item.id)}
                      >
                        <Icon size={15} />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {geometryMode === "full" && (
                <div className="info-panel">
                  <Maximize2 size={17} />
                  <div>
                    <strong>Full source image</strong>
                    <span>
                      The complete {sourceWidth} × {sourceHeight} frame is
                      resized to the model input.
                    </span>
                  </div>
                </div>
              )}

              {geometryMode === "crop" && (
                <>
                  <div className="field-group">
                    <label className="field-label">Crop position</label>
                    <div className="field-pair">
                      <NumberField
                        label="X"
                        value={cropGeometry.x}
                        onChange={(x) =>
                          setCropGeometry((value) => ({ ...value, x }))
                        }
                      />
                      <NumberField
                        label="Y"
                        value={cropGeometry.y}
                        onChange={(y) =>
                          setCropGeometry((value) => ({ ...value, y }))
                        }
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Crop size</label>
                    <div className="field-pair">
                      <NumberField
                        label="Width"
                        value={cropGeometry.width}
                        min={1}
                        onChange={(width) =>
                          setCropGeometry((value) => ({ ...value, width }))
                        }
                      />
                      <NumberField
                        label="Height"
                        value={cropGeometry.height}
                        min={1}
                        onChange={(height) =>
                          setCropGeometry((value) => ({ ...value, height }))
                        }
                      />
                    </div>
                  </div>
                  <div className="derived-row">
                    <span className="status-dot">
                      <Check size={13} />
                    </span>
                    <div>
                      <strong>Output restoration</strong>
                      <span>Generated automatically from this crop</span>
                    </div>
                    <span className="derived-badge">Derived</span>
                  </div>
                </>
              )}

              {geometryMode === "annulus" && (
                <>
                  <div className="field-group">
                    <label className="field-label">Center · [x, y]</label>
                    <div className="field-pair">
                      <NumberField
                        label="X"
                        value={annulusGeometry.cx}
                        onChange={(cx) =>
                          setAnnulusGeometry((value) => ({ ...value, cx }))
                        }
                      />
                      <NumberField
                        label="Y"
                        value={annulusGeometry.cy}
                        onChange={(cy) =>
                          setAnnulusGeometry((value) => ({ ...value, cy }))
                        }
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Radii</label>
                    <div className="field-pair">
                      <NumberField
                        label="Inner"
                        value={annulusGeometry.innerRadius}
                        min={1}
                        onChange={(innerRadius) =>
                          setAnnulusGeometry((value) => ({
                            ...value,
                            innerRadius,
                          }))
                        }
                      />
                      <NumberField
                        label="Outer"
                        value={annulusGeometry.outerRadius}
                        min={2}
                        onChange={(outerRadius) =>
                          setAnnulusGeometry((value) => ({
                            ...value,
                            outerRadius,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">
                      Unwrapped strip · [height, width]
                    </label>
                    <div className="field-pair">
                      <NumberField
                        label="Height"
                        value={annulusGeometry.stripHeight}
                        min={1}
                        onChange={(stripHeight) =>
                          setAnnulusGeometry((value) => ({
                            ...value,
                            stripHeight,
                          }))
                        }
                      />
                      <NumberField
                        label="Width"
                        value={annulusGeometry.stripWidth}
                        min={1}
                        onChange={(stripWidth) =>
                          setAnnulusGeometry((value) => ({
                            ...value,
                            stripWidth,
                          }))
                        }
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="panel-footer">
                <div className="footer-status success">
                  <Check size={15} />
                  Geometry fits the source
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => setStep("region")}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          {step === "region" && (
            <div className="settings-content">
              <div className="field-group">
                <label className="field-label" htmlFor="region-mode">
                  Region type
                </label>
                <select
                  id="region-mode"
                  value={regionMode}
                  onChange={(event) =>
                    setRegionMode(event.target.value as RegionMode)
                  }
                >
                  <option value="static">Static mask — draw shapes</option>
                  <option value="dynamic">
                    Dynamic ellipse — detect per image
                  </option>
                  <option value="none">No valid region</option>
                </select>
              </div>

              {regionMode === "static" && (
                <>
                  <div className="field-group">
                    <label className="field-label">Shape operation</label>
                    <div className="segmented-control two">
                      <button
                        type="button"
                        className={operation === "include" ? "active" : ""}
                        onClick={() => setOperation("include")}
                      >
                        Include
                      </button>
                      <button
                        type="button"
                        className={`exclude ${
                          operation === "exclude" ? "active" : ""
                        }`}
                        onClick={() => setOperation("exclude")}
                      >
                        Exclude
                      </button>
                    </div>
                  </div>

                  <div className="section-block">
                    <div className="section-heading">
                      <div className="section-label">
                        SHAPES · {shapes.length}
                      </div>
                      <div className="mini-actions">
                        <button
                          className="icon-button"
                          type="button"
                          aria-label="Undo"
                          disabled={!undoStack.length}
                          onClick={undo}
                        >
                          <Undo2 size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          aria-label="Redo"
                          disabled={!redoStack.length}
                          onClick={redo}
                        >
                          <Redo2 size={15} />
                        </button>
                      </div>
                    </div>
                    <div className="shape-list">
                      {shapes.map((shape) => (
                        <div
                          className={`shape-row ${
                            selectedShapeId === shape.id ? "active" : ""
                          }`}
                          key={shape.id}
                        >
                          <button
                            type="button"
                            className="shape-main"
                            onClick={() => {
                              setTool("select");
                              setSelectedShapeId(shape.id);
                            }}
                          >
                            <span
                              className={`shape-type-icon ${shape.operation}`}
                            >
                              {shape.type === "polygon" ? (
                                <Hexagon size={14} />
                              ) : (
                                <Circle size={14} />
                              )}
                            </span>
                            <span className="shape-copy">
                              <strong>{shape.name}</strong>
                              <span>
                                {shape.type} · {shape.operation}
                              </span>
                            </span>
                          </button>
                          <button
                            className="icon-button danger"
                            type="button"
                            aria-label={`Delete ${shape.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeShape(shape.id);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {!shapes.length && (
                        <div className="empty-state">
                          Choose Polygon or Ellipse, then draw on the image.
                        </div>
                      )}
                    </div>
                  </div>

                  {draftPolygon.length > 0 && (
                    <div className="draft-actions">
                      <span>{draftPolygon.length} polygon points</span>
                      <button
                        type="button"
                        className="button button-secondary compact"
                        disabled={draftPolygon.length < 3}
                        onClick={finishPolygon}
                      >
                        Finish polygon
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="Cancel polygon"
                        onClick={() => setDraftPolygon([])}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}

                  {selectedShape && (
                    <div className="selected-shape-note">
                      <MousePointer2 size={15} />
                      Drag the selected {selectedShape.type} to reposition it.
                    </div>
                  )}

                  <div className="field-group">
                    <label className="field-label" htmlFor="opacity">
                      Overlay opacity <span>{overlayOpacity}%</span>
                    </label>
                    <input
                      id="opacity"
                      type="range"
                      min={8}
                      max={55}
                      value={overlayOpacity}
                      onChange={(event) =>
                        setOverlayOpacity(Number(event.target.value))
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="mask-name">
                      Mask filename
                    </label>
                    <input
                      id="mask-name"
                      type="text"
                      value={maskName}
                      onChange={(event) => setMaskName(event.target.value)}
                    />
                    <div className="field-hint">
                      Saved under dataset/valid_regions/
                    </div>
                  </div>
                </>
              )}

              {regionMode === "dynamic" && (
                <>
                  <div className="info-panel">
                    <WandSparkles size={17} />
                    <div>
                      <strong>Detected separately in every image</strong>
                      <span>
                        Diameters are measured after preprocessing and before
                        model resize.
                      </span>
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Diameter range · pixels</label>
                    <div className="field-pair">
                      <NumberField
                        label="Minimum"
                        value={dynamicMin}
                        min={1}
                        onChange={setDynamicMin}
                      />
                      <NumberField
                        label="Maximum"
                        value={dynamicMax}
                        min={2}
                        onChange={setDynamicMax}
                      />
                    </div>
                  </div>
                </>
              )}

              {regionMode === "none" && (
                <div className="info-panel">
                  <Layers3 size={17} />
                  <div>
                    <strong>No mask will be generated</strong>
                    <span>
                      Every pixel remaining after preprocessing is considered
                      valid.
                    </span>
                  </div>
                </div>
              )}

              <div className="panel-footer">
                <div
                  className={`footer-status ${
                    validation[3]?.ok ? "success" : "error"
                  }`}
                >
                  {validation[3]?.ok ? (
                    <Check size={15} />
                  ) : (
                    <AlertCircle size={15} />
                  )}
                  {validation[3]?.label}
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => setStep("model")}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          {step === "model" && (
            <div className="settings-content">
              <div className="field-group">
                <label className="field-label">
                  Model input · [height, width]
                </label>
                <div className="field-pair">
                  <NumberField
                    label="Height"
                    value={inputHeight}
                    min={1}
                    onChange={setInputHeight}
                  />
                  <NumberField
                    label="Width"
                    value={inputWidth}
                    min={1}
                    onChange={setInputWidth}
                  />
                </div>
              </div>

              <ToggleRow
                checked={tilingEnabled}
                onChange={setTilingEnabled}
                icon={<Grid3X3 size={16} />}
                title="Enable tiling"
                detail={
                  tilingEnabled
                    ? `${activeTiles.length} of ${tilingTiles.length} included`
                    : "One complete model input"
                }
              />

              {tilingEnabled && (
                <>
                  <div className="field-group">
                    <label className="field-label">
                      Tile size · [height, width]
                    </label>
                    <div className="field-pair">
                      <NumberField
                        label="Height"
                        value={tileHeight}
                        min={1}
                        onChange={setTileHeight}
                      />
                      <NumberField
                        label="Width"
                        value={tileWidth}
                        min={1}
                        onChange={setTileWidth}
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">
                      Stride · [height, width]
                    </label>
                    <div className="field-pair">
                      <NumberField
                        label="Height"
                        value={strideHeight}
                        min={1}
                        onChange={setStrideHeight}
                      />
                      <NumberField
                        label="Width"
                        value={strideWidth}
                        min={1}
                        onChange={setStrideWidth}
                      />
                    </div>
                  </div>
                  <div className="tile-legend">
                    <span>
                      <i className="included" /> Included
                    </span>
                    <span>
                      <i className="skipped" /> Below 30% ROI
                    </span>
                  </div>
                </>
              )}

              <ToggleRow
                checked={artifactEnabled}
                onChange={setArtifactEnabled}
                icon={<ImageIcon size={16} />}
                title="Limit artifact size"
                detail="Preserves aspect ratio"
              />
              {artifactEnabled && (
                <div className="field-group">
                  <label className="field-label">
                    Artifact maximum · [width, height]
                  </label>
                  <div className="field-pair">
                    <NumberField
                      label="Width"
                      value={artifactWidth}
                      min={1}
                      onChange={setArtifactWidth}
                    />
                    <NumberField
                      label="Height"
                      value={artifactHeight}
                      min={1}
                      onChange={setArtifactHeight}
                    />
                  </div>
                </div>
              )}

              <div className="panel-footer">
                <div
                  className={`footer-status ${
                    validation[4]?.ok ? "success" : "error"
                  }`}
                >
                  {validation[4]?.ok ? (
                    <Check size={15} />
                  ) : (
                    <AlertCircle size={15} />
                  )}
                  {validation[4]?.label}
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => setStep("review")}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="settings-content">
              <div className="field-group">
                <label className="field-label" htmlFor="profile-name">
                  Profile name
                </label>
                <input
                  id="profile-name"
                  type="text"
                  value={profileName}
                  onChange={(event) => {
                    const value = event.target.value;
                    setProfileName(value);
                    if (
                      !maskName ||
                      maskName === `${slugify(profileName)}_roi.png`
                    ) {
                      setMaskName(`${slugify(value)}_roi.png`);
                    }
                  }}
                />
                <div className="field-hint">
                  Exported as profiles/{slugify(profileName)}.json
                </div>
              </div>

              <div className="section-block">
                <div className="section-label">VALIDATION</div>
                <div className="validation-list">
                  {validation.map((check) => (
                    <div className="validation-row" key={check.label}>
                      <span
                        className={`validation-icon ${
                          check.ok ? "success" : "error"
                        }`}
                      >
                        {check.ok ? (
                          <Check size={13} />
                        ) : (
                          <AlertCircle size={13} />
                        )}
                      </span>
                      <span>{check.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="section-block">
                <div className="section-heading">
                  <div className="section-label">PROFILE JSON</div>
                  <span className="derived-badge">Live</span>
                </div>
                <pre className="json-preview">
                  {JSON.stringify(profile, null, 2)}
                </pre>
              </div>

              <div className="bundle-list">
                <div className="bundle-row">
                  <FileJson size={15} />
                  <span>profiles/{slugify(profileName)}.json</span>
                  <Check size={14} />
                </div>
                {regionMode === "static" && (
                  <div className="bundle-row">
                    <ImageIcon size={15} />
                    <span>dataset/valid_regions/{maskName}</span>
                    <Check size={14} />
                  </div>
                )}
                <div className="bundle-row">
                  <FileCheck2 size={15} />
                  <span>manifest.json + editable project</span>
                  <Check size={14} />
                </div>
              </div>

              <button
                className="button button-primary export-button"
                type="button"
                disabled={
                  exporting || validation.some((check) => !check.ok)
                }
                onClick={exportBundle}
              >
                {exporting ? (
                  <>
                    <RotateCcw className="spinning" size={17} />
                    Preparing bundle…
                  </>
                ) : (
                  <>
                    <FolderArchive size={17} />
                    Download profile bundle
                  </>
                )}
              </button>

              <button
                className="text-button"
                type="button"
                onClick={resetDraft}
              >
                Reset example draft
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const handleFocusedWheel = (event: WheelEvent) => {
      if (document.activeElement !== input || event.deltaY === 0) return;

      event.preventDefault();
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
      onChange(input.valueAsNumber);
    };

    input.addEventListener("wheel", handleFocusedWheel, { passive: false });
    return () => input.removeEventListener("wheel", handleFocusedWheel);
  }, [onChange]);

  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        ref={inputRef}
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ToggleRow({
  checked,
  onChange,
  icon,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-icon">{icon}</span>
      <span className="toggle-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-control" aria-hidden="true" />
    </label>
  );
}
