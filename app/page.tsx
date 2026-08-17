"use client";

import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  Crop,
  Download,
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
  Scaling,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import JSZip from "jszip";
import {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
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

type ProjectReference = {
  id: string;
  name: string;
  path: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
};

type StudioProject = {
  profilePath: string;
  sourceSize: { width: number; height: number };
  references: ProjectReference[];
  activeReferenceId: string | null;
  shapes: RoiShape[];
  dynamicCenter: Point;
  step: Step;
  customized: {
    strip: boolean;
    tiling: boolean;
    dynamic: boolean;
    modelInput: boolean;
    artifact: boolean;
  };
};

type CropGeometry = { x: number; y: number; width: number; height: number };
type CropCorner = "north-west" | "north-east" | "south-west" | "south-east";
type AnnulusControl = "move" | "inner-radius" | "outer-radius";
type EllipseAxis = "horizontal" | "vertical";
type DynamicEllipseControl = "move" | "minimum" | "maximum";
type AnnulusGeometry = {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
  stripHeight: number;
  stripWidth: number;
};
type ProcessedMask = { width: number; height: number; pixels: Uint8Array };
type ValidationCheck = { ok: boolean; label: string; step: Step };
type ContextMessage = { message: string; tone: "warning" | "error" };

type PolygonDraftHandle = {
  addPoint: (point: Point) => void;
  clear: () => void;
  getPoints: () => Point[];
};

const MASK_PREVIEW_MAX_DIMENSION = 640;
const DEFAULT_MASK_NAME = "valid_region.png";

const PolygonDraftLayer = forwardRef<
  PolygonDraftHandle,
  {
    operation: Operation;
    handleRadius: number;
    visible: boolean;
    onActiveChange: (active: boolean) => void;
  }
>(function PolygonDraftLayer(
  { operation, handleRadius, visible, onActiveChange },
  ref,
) {
  const [points, setPoints] = useState<Point[]>([]);
  const pointsRef = useRef<Point[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      addPoint(point) {
        const next = [...pointsRef.current, point];
        if (pointsRef.current.length === 0) onActiveChange(true);
        pointsRef.current = next;
        setPoints(next);
      },
      clear() {
        if (pointsRef.current.length > 0) onActiveChange(false);
        pointsRef.current = [];
        setPoints([]);
      },
      getPoints() {
        return pointsRef.current;
      },
    }),
    [onActiveChange],
  );

  if (points.length === 0) return null;

  return (
    <g display={visible ? undefined : "none"}>
      <polyline
        points={points.map((point) => `${point.x},${point.y}`).join(" ")}
        className={`draft-shape ${operation}`}
      />
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={handleRadius}
          className={`roi-handle ${operation}`}
        />
      ))}
    </g>
  );
});

type DragState =
  | {
      kind: "shape";
      shapeId: string;
      start: Point;
      original: RoiShape;
    }
  | {
      kind: "polygon-point";
      shapeId: string;
      pointIndex: number;
      start: Point;
      original: PolygonShape;
    }
  | {
      kind: "ellipse-radius";
      shapeId: string;
      axis: EllipseAxis;
      start: Point;
      original: EllipseShape;
    }
  | {
      kind: "crop";
      corner?: CropCorner;
      start: Point;
      original: CropGeometry;
    }
  | {
      kind: "annulus";
      control: AnnulusControl;
      start: Point;
      original: AnnulusGeometry;
    }
  | {
      kind: "dynamic-ellipse";
      control: DynamicEllipseControl;
      start: Point;
      originalCenter: Point;
      originalMin: number;
      originalMax: number;
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

const roundToMultiple = (value: number, multiple: number) =>
  Math.max(multiple, Math.round(value / multiple) * multiple);

const recommendedAnnulusStrip = (innerRadius: number, outerRadius: number) => ({
  stripHeight: Math.max(1, Math.round(outerRadius - innerRadius)),
  stripWidth: roundToMultiple(Math.PI * (innerRadius + outerRadius), 16),
});

const recommendedTiling = (
  width: number,
  height: number,
  mode: GeometryMode,
) => {
  const practicalEdge = (edge: number, target: number) => {
    const bounded = Math.min(edge, target);
    return bounded < 32
      ? Math.max(1, Math.round(bounded))
      : Math.max(16, Math.floor(bounded / 16) * 16);
  };
  const tileHeight =
    mode === "annulus"
      ? Math.max(1, Math.round(height))
      : practicalEdge(height, 512);
  const tileWidth =
    mode === "annulus"
      ? practicalEdge(width, Math.max(256, height * 4))
      : practicalEdge(width, 512);

  return {
    tileHeight,
    tileWidth,
    strideHeight: Math.max(1, Math.round(tileHeight / 2)),
    strideWidth: Math.max(1, Math.round(tileWidth / 2)),
  };
};

const recommendedDynamicRange = (width: number, height: number) => {
  const shortEdge = Math.max(2, Math.min(width, height));
  const minimum = Math.max(1, Math.round(shortEdge * 0.6));
  return {
    minimum,
    maximum: Math.max(minimum + 1, Math.round(shortEdge * 0.85)),
  };
};

const recommendedAnnulusInput = (width: number, height: number) => {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
};

const parseObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const parseNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  return value;
};

const parsePositiveInteger = (value: unknown, label: string): number => {
  const number = parseNumber(value, label);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return number;
};

const parseNamedNumberPair = (
  value: unknown,
  label: string,
  firstKey: string,
  secondKey: string,
): [number, number] => {
  const data = parseObject(value, label);
  const expectedKeys = new Set([firstKey, secondKey]);
  const missingKey = [firstKey, secondKey].find((key) => !(key in data));
  if (missingKey) {
    throw new Error(`${label}.${missingKey} is required.`);
  }
  const unexpectedKey = Object.keys(data).find((key) => !expectedKeys.has(key));
  if (unexpectedKey) {
    throw new Error(`${label}.${unexpectedKey} is not supported.`);
  }
  return [
    parseNumber(data[firstKey], `${label}.${firstKey}`),
    parseNumber(data[secondKey], `${label}.${secondKey}`),
  ];
};

const parseString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const parseBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
};

const parsePoint = (value: unknown, label: string): Point => {
  const [x, y] = parseNamedNumberPair(value, label, "x", "y");
  return { x, y };
};

const parseShapes = (value: unknown): RoiShape[] => {
  if (!Array.isArray(value)) {
    throw new Error("static_region_shapes must be an array.");
  }
  return value.map((item, index) => {
    const label = `static_region_shapes[${index}]`;
    const shape = parseObject(item, label);
    const id = parseString(shape.id, `${label}.id`);
    const name = parseString(shape.name, `${label}.name`);
    if (shape.operation !== "include" && shape.operation !== "exclude") {
      throw new Error(`${label}.operation must be include or exclude.`);
    }
    if (shape.type === "polygon") {
      if (!Array.isArray(shape.points) || shape.points.length < 3) {
        throw new Error(`${label}.points must contain at least three points.`);
      }
      return {
        id,
        name,
        operation: shape.operation,
        type: "polygon",
        points: shape.points.map((point, pointIndex) =>
          parsePoint(point, `${label}.points[${pointIndex}]`),
        ),
      };
    }
    if (shape.type === "ellipse") {
      return {
        id,
        name,
        operation: shape.operation,
        type: "ellipse",
        cx: parseNumber(shape.cx, `${label}.cx`),
        cy: parseNumber(shape.cy, `${label}.cy`),
        rx: parseNumber(shape.rx, `${label}.rx`),
        ry: parseNumber(shape.ry, `${label}.ry`),
      };
    }
    throw new Error(`${label}.type must be polygon or ellipse.`);
  });
};

const isSafeZipPath = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

const parseStudioProject = (value: unknown): StudioProject => {
  const data = parseObject(value, "studio/project.json");
  const profilePath = parseString(data.profile_path, "profile_path");
  if (!isSafeZipPath(profilePath) || !profilePath.startsWith("profiles/")) {
    throw new Error("profile_path must point to a safe path under profiles/.");
  }
  const [sourceWidth, sourceHeight] = parseNamedNumberPair(
    data.source_size,
    "source_size",
    "width",
    "height",
  );
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    throw new Error("source_size dimensions must be positive whole numbers.");
  }
  if (!Array.isArray(data.reference_images) || data.reference_images.length === 0) {
    throw new Error("reference_images must contain at least one image.");
  }
  const references = data.reference_images.map((item, index) => {
    const label = `reference_images[${index}]`;
    const reference = parseObject(item, label);
    const path = parseString(reference.path, `${label}.path`);
    if (!isSafeZipPath(path) || !path.startsWith("studio/reference_images/")) {
      throw new Error(`${label}.path must be a safe reference image path.`);
    }
    return {
      id: parseString(reference.id, `${label}.id`),
      name: parseString(reference.name, `${label}.name`),
      path,
      mediaType:
        reference.media_type === undefined
          ? "application/octet-stream"
          : parseString(reference.media_type, `${label}.media_type`),
      width: parsePositiveInteger(reference.width, `${label}.width`),
      height: parsePositiveInteger(reference.height, `${label}.height`),
      bytes: parsePositiveInteger(reference.bytes, `${label}.bytes`),
    };
  });
  const referenceIds = new Set(references.map((reference) => reference.id));
  if (referenceIds.size !== references.length) {
    throw new Error("reference image ids must be unique.");
  }
  const activeReferenceId =
    data.active_reference_id === null
      ? null
      : parseString(data.active_reference_id, "active_reference_id");
  if (activeReferenceId && !referenceIds.has(activeReferenceId)) {
    throw new Error("active_reference_id does not match a reference image.");
  }
  if (typeof data.step !== "string" || !STEPS.some((item) => item.id === data.step)) {
    throw new Error("step is not a recognized Studio step.");
  }
  const customized = parseObject(data.customized, "customized");
  return {
    profilePath,
    sourceSize: { width: sourceWidth, height: sourceHeight },
    references,
    activeReferenceId,
    shapes: parseShapes(data.static_region_shapes),
    dynamicCenter: parsePoint(
      data.dynamic_region_preview_center,
      "dynamic_region_preview_center",
    ),
    step: data.step as Step,
    customized: {
      strip: parseBoolean(customized.strip, "customized.strip"),
      tiling: parseBoolean(customized.tiling, "customized.tiling"),
      dynamic: parseBoolean(customized.dynamic, "customized.dynamic"),
      modelInput: parseBoolean(customized.model_input, "customized.model_input"),
      artifact: parseBoolean(customized.artifact, "customized.artifact"),
    },
  };
};

const referenceFilename = (name: string, usedNames: Set<string>) => {
  const rawBasename =
    name.split(/[\\/]/).at(-1)?.replaceAll("\0", "").trim() || "reference";
  const basename = rawBasename === "." || rawBasename === ".." ? "reference" : rawBasename;
  const dotIndex = basename.lastIndexOf(".");
  const stem = dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
  const extension = dotIndex > 0 ? basename.slice(dotIndex) : "";
  let candidate = basename;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) {
    candidate = `${stem}_${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
};

const loadReferenceImage = (
  blob: Blob,
  reference: ProjectReference,
): Promise<SampleImage> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      if (
        image.naturalWidth !== reference.width ||
        image.naturalHeight !== reference.height
      ) {
        URL.revokeObjectURL(url);
        reject(new Error(`${reference.name} does not match its saved dimensions.`));
        return;
      }
      resolve({
        id: reference.id,
        name: reference.name,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        bytes: blob.size,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read reference image ${reference.name}.`));
    };
    image.src = url;
  });

const polarPoint = (cx: number, cy: number, radius: number, angle: number) => ({
  x: cx + radius * Math.cos(angle),
  y: cy + radius * Math.sin(angle),
});

const annularSectorPath = (
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) => {
  const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
  const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M${outerStart.x} ${outerStart.y}`,
    `A${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L${innerEnd.x} ${innerEnd.y}`,
    `A${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
};

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

const renderMask = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  shapes: RoiShape[],
) => {
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
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
};

const clipToGeometry = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  geometryMode: GeometryMode,
  crop: CropGeometry,
  annulus: AnnulusGeometry,
) => {
  context.beginPath();
  if (geometryMode === "full") {
    context.rect(0, 0, width, height);
    context.clip();
    return;
  }
  if (geometryMode === "crop") {
    context.rect(crop.x, crop.y, crop.width, crop.height);
    context.clip();
    return;
  }

  context.arc(annulus.cx, annulus.cy, annulus.outerRadius, 0, Math.PI * 2);
  context.arc(annulus.cx, annulus.cy, annulus.innerRadius, 0, Math.PI * 2);
  context.clip("evenodd");
};

const makeMaskBinary = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  const image = context.getImageData(0, 0, width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = image.data[index] >= 128 ? 255 : 0;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
};

const renderFinalMask = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  shapes: RoiShape[],
  geometryMode: GeometryMode,
  crop: CropGeometry,
  annulus: AnnulusGeometry,
) => {
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.save();
  clipToGeometry(context, width, height, geometryMode, crop, annulus);
  renderMask(context, width, height, shapes);
  context.restore();
  makeMaskBinary(context, width, height);
};

const renderFinalMaskPreview = (
  context: CanvasRenderingContext2D,
  previewWidth: number,
  previewHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  shapes: RoiShape[],
  geometryMode: GeometryMode,
  crop: CropGeometry,
  annulus: AnnulusGeometry,
) => {
  context.save();
  context.scale(previewWidth / sourceWidth, previewHeight / sourceHeight);
  context.fillStyle = "#000";
  context.fillRect(0, 0, sourceWidth, sourceHeight);
  context.save();
  clipToGeometry(
    context,
    sourceWidth,
    sourceHeight,
    geometryMode,
    crop,
    annulus,
  );
  renderMask(context, sourceWidth, sourceHeight, shapes);
  context.restore();
  context.restore();
  makeMaskBinary(context, previewWidth, previewHeight);
};

const drawProcessedRaster = (
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
  geometryMode: GeometryMode,
  crop: CropGeometry,
  annulus: AnnulusGeometry,
  smoothing: boolean,
) => {
  const context = target.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = smoothing;

  if (geometryMode === "full") {
    context.drawImage(source, 0, 0);
    return;
  }
  if (geometryMode === "crop") {
    context.drawImage(
      source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      target.width,
      target.height,
    );
    return;
  }

  const sourceContext = source.getContext("2d");
  if (!sourceContext) return;
  const sourceData = sourceContext.getImageData(0, 0, source.width, source.height);
  const output = context.createImageData(target.width, target.height);
  const radialSpan = annulus.outerRadius - annulus.innerRadius;
  for (let y = 0; y < target.height; y += 1) {
    const radius =
      annulus.innerRadius + ((y + 0.5) / target.height) * radialSpan;
    for (let x = 0; x < target.width; x += 1) {
      const angle = ((x + 0.5) / target.width) * Math.PI * 2;
      const sourceX = Math.round(annulus.cx + radius * Math.cos(angle));
      const sourceY = Math.round(annulus.cy + radius * Math.sin(angle));
      const outputIndex = (y * target.width + x) * 4;
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= source.width ||
        sourceY >= source.height
      ) {
        output.data[outputIndex + 3] = 255;
        continue;
      }
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      output.data[outputIndex] = sourceData.data[sourceIndex];
      output.data[outputIndex + 1] = sourceData.data[sourceIndex + 1];
      output.data[outputIndex + 2] = sourceData.data[sourceIndex + 2];
      output.data[outputIndex + 3] = sourceData.data[sourceIndex + 3];
    }
  }
  context.putImageData(output, 0, 0);
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
  const [profileName, setProfileName] = useState("new_profile");
  const [samples, setSamples] = useState<SampleImage[]>([]);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [fallbackSourceSize, setFallbackSourceSize] = useState({
    width: DEFAULT_CANVAS_WIDTH,
    height: DEFAULT_CANVAS_HEIGHT,
  });
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
  const [regionMode, setRegionMode] = useState<RegionMode>("none");
  const [tool, setTool] = useState<DrawingTool>("select");
  const [operation, setOperation] = useState<Operation>("include");
  const [shapes, setShapes] = useState<RoiShape[]>(initialShapes);
  const [undoStack, setUndoStack] = useState<RoiShape[][]>([]);
  const [redoStack, setRedoStack] = useState<RoiShape[][]>([]);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [hasDraftPolygon, setHasDraftPolygon] = useState(false);
  const [ellipseStart, setEllipseStart] = useState<Point | null>(null);
  const [ellipseCurrent, setEllipseCurrent] = useState<Point | null>(null);
  const [dragState, setDragState] = useState<DragState>(null);
  const [maskName, setMaskName] = useState(DEFAULT_MASK_NAME);
  const [dynamicMin, setDynamicMin] = useState(400);
  const [dynamicMax, setDynamicMax] = useState(510);
  const [dynamicCenter, setDynamicCenter] = useState<Point>({
    x: DEFAULT_CANVAS_WIDTH / 2,
    y: DEFAULT_CANVAS_HEIGHT / 2,
  });
  const [inputHeight, setInputHeight] = useState(256);
  const [inputWidth, setInputWidth] = useState(256);
  const [tilingEnabled, setTilingEnabled] = useState(false);
  const [tileHeight, setTileHeight] = useState(128);
  const [tileWidth, setTileWidth] = useState(128);
  const [strideHeight, setStrideHeight] = useState(64);
  const [strideWidth, setStrideWidth] = useState(64);
  const [artifactEnabled, setArtifactEnabled] = useState(true);
  const [artifactWidth, setArtifactWidth] = useState(1024);
  const [artifactHeight, setArtifactHeight] = useState(1024);
  const [exporting, setExporting] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<ContextMessage | null>(null);
  const [importMessage, setImportMessage] = useState<ContextMessage | null>(null);
  const [exportMessage, setExportMessage] = useState<ContextMessage | null>(null);
  const [staticMaskNeedsRedraw, setStaticMaskNeedsRedraw] = useState(false);
  const [processedMask, setProcessedMask] = useState<ProcessedMask | null>(null);
  const [staticMaskHasPixels, setStaticMaskHasPixels] = useState<boolean | null>(null);
  const [hoveredTileId, setHoveredTileId] = useState<number | null>(null);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const maskPreviewRef = useRef<HTMLCanvasElement>(null);
  const processedPreviewRef = useRef<HTMLCanvasElement>(null);
  const processedMaskPreviewRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<SampleImage[]>([]);
  const polygonDraftRef = useRef<PolygonDraftHandle>(null);
  const stripCustomizedRef = useRef(false);
  const tilingCustomizedRef = useRef(false);
  const dynamicCustomizedRef = useRef(false);

  const modelInputCustomizedRef = useRef(false);
  const artifactCustomizedRef = useRef(false);

  const activeSample =
    samples.find((sample) => sample.id === activeSampleId) ?? samples[0] ?? null;
  const sourceWidth = activeSample?.width ?? fallbackSourceSize.width;
  const sourceHeight = activeSample?.height ?? fallbackSourceSize.height;
  const processedWidth = Math.max(
    1,
    safeInteger(
      geometryMode === "crop"
        ? cropGeometry.width
        : geometryMode === "annulus"
          ? annulusGeometry.stripWidth
          : sourceWidth,
    ),
  );
  const processedHeight = Math.max(
    1,
    safeInteger(
      geometryMode === "crop"
        ? cropGeometry.height
        : geometryMode === "annulus"
          ? annulusGeometry.stripHeight
          : sourceHeight,
    ),
  );
  const needsProcessedPreview = step === "model" || step === "review";
  const isShapeDragging =
    dragState?.kind === "shape" ||
    dragState?.kind === "polygon-point" ||
    dragState?.kind === "ellipse-radius";
  const previewWidth = sourceWidth;
  const previewHeight = sourceHeight;

  const applyRecommendedTiling = (
    width = processedWidth,
    height = processedHeight,
    mode = geometryMode,
  ) => {
    const recommendation = recommendedTiling(width, height, mode);
    setTileHeight(recommendation.tileHeight);
    setTileWidth(recommendation.tileWidth);
    setStrideHeight(recommendation.strideHeight);
    setStrideWidth(recommendation.strideWidth);
  };

  const handleGeometryModeChange = (mode: GeometryMode) => {
    setGeometryMode(mode);
    const width =
      mode === "crop"
        ? cropGeometry.width
        : mode === "annulus"
          ? annulusGeometry.stripWidth
          : sourceWidth;
    const height =
      mode === "crop"
        ? cropGeometry.height
        : mode === "annulus"
          ? annulusGeometry.stripHeight
          : sourceHeight;

    if (!dynamicCustomizedRef.current) {
      const recommendation = recommendedDynamicRange(width, height);
      setDynamicMin(recommendation.minimum);
      setDynamicMax(recommendation.maximum);
    }
    if (tilingEnabled && !tilingCustomizedRef.current) {
      applyRecommendedTiling(width, height, mode);
    }
    if (mode === "annulus" && !modelInputCustomizedRef.current) {
      const recommendation = recommendedAnnulusInput(width, height);
      setInputHeight(recommendation.height);
      setInputWidth(recommendation.width);
    }
  };

  const handleTilingChange = (enabled: boolean) => {
    if (enabled && !tilingCustomizedRef.current) applyRecommendedTiling();
    setTilingEnabled(enabled);
  };

  useEffect(() => {
    if (!dynamicCustomizedRef.current) {
      const recommendation = recommendedDynamicRange(processedWidth, processedHeight);
      setDynamicMin(recommendation.minimum);
      setDynamicMax(recommendation.maximum);
    }
    if (tilingEnabled && !tilingCustomizedRef.current) {
      const recommendation = recommendedTiling(
        processedWidth,
        processedHeight,
        geometryMode,
      );
      setTileHeight(recommendation.tileHeight);
      setTileWidth(recommendation.tileWidth);
      setStrideHeight(recommendation.strideHeight);
      setStrideWidth(recommendation.strideWidth);
    }
    if (geometryMode === "annulus" && !modelInputCustomizedRef.current) {
      const recommendation = recommendedAnnulusInput(processedWidth, processedHeight);
      setInputHeight(recommendation.height);
      setInputWidth(recommendation.width);
    }
  }, [geometryMode, processedHeight, processedWidth, tilingEnabled]);

  useEffect(() => {
    // Keep the SVG editing overlay responsive. The small mask preview catches
    // up once the drag ends instead of competing with every pointer event.
    if (isShapeDragging) return;
    const canvas = maskPreviewRef.current;
    if (!canvas) return;
    const previewScale = Math.min(
      1,
      MASK_PREVIEW_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight),
    );
    canvas.width = Math.max(1, Math.round(sourceWidth * previewScale));
    canvas.height = Math.max(1, Math.round(sourceHeight * previewScale));
    const context = canvas.getContext("2d");
    if (!context) return;
    renderFinalMaskPreview(
      context,
      canvas.width,
      canvas.height,
      sourceWidth,
      sourceHeight,
      shapes,
      geometryMode,
      cropGeometry,
      annulusGeometry,
    );
    let maskHasPixels: boolean | null = null;
    if (regionMode === "static") {
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      maskHasPixels = false;
      for (let index = 0; index < rgba.length; index += 4) {
        if (rgba[index] > 0) {
          maskHasPixels = true;
          break;
        }
      }
    }
    const maskStateTimer = window.setTimeout(
      () => setStaticMaskHasPixels(maskHasPixels),
      0,
    );
    return () => window.clearTimeout(maskStateTimer);
  }, [
    shapes,
    sourceWidth,
    sourceHeight,
    geometryMode,
    cropGeometry,
    annulusGeometry,
    regionMode,
    step,
    isShapeDragging,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!activeSample || !needsProcessedPreview) {
      return;
    }

    const renderProcessedPreview = async () => {
      const image = new Image();
      image.src = activeSample.url;
      await image.decode();
      if (cancelled) return;

      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = sourceWidth;
      sourceCanvas.height = sourceHeight;
      const sourceContext = sourceCanvas.getContext("2d");
      if (!sourceContext) return;
      sourceContext.drawImage(image, 0, 0, sourceWidth, sourceHeight);

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = processedWidth;
      outputCanvas.height = processedHeight;
      drawProcessedRaster(
        sourceCanvas,
        outputCanvas,
        geometryMode,
        cropGeometry,
        annulusGeometry,
        true,
      );

      const preview = processedPreviewRef.current;
      if (preview) {
        preview.width = processedWidth;
        preview.height = processedHeight;
        preview.getContext("2d")?.drawImage(outputCanvas, 0, 0);
      }

      if (regionMode !== "static") {
        setProcessedMask(null);
        return;
      }
      const sourceMaskCanvas = document.createElement("canvas");
      sourceMaskCanvas.width = sourceWidth;
      sourceMaskCanvas.height = sourceHeight;
      const sourceMaskContext = sourceMaskCanvas.getContext("2d");
      if (!sourceMaskContext) return;
      renderFinalMask(
        sourceMaskContext,
        sourceWidth,
        sourceHeight,
        shapes,
        geometryMode,
        cropGeometry,
        annulusGeometry,
      );

      const processedMaskCanvas = document.createElement("canvas");
      processedMaskCanvas.width = processedWidth;
      processedMaskCanvas.height = processedHeight;
      drawProcessedRaster(
        sourceMaskCanvas,
        processedMaskCanvas,
        geometryMode,
        cropGeometry,
        annulusGeometry,
        false,
      );
      const maskContext = processedMaskCanvas.getContext("2d");
      if (!maskContext || cancelled) return;
      const rgba = maskContext.getImageData(0, 0, processedWidth, processedHeight).data;
      const pixels = new Uint8Array(processedWidth * processedHeight);
      for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = rgba[index * 4] > 0 ? 1 : 0;
      }
      setProcessedMask({ width: processedWidth, height: processedHeight, pixels });
    };

    void renderProcessedPreview();
    return () => {
      cancelled = true;
    };
  }, [
    activeSample,
    sourceWidth,
    sourceHeight,
    processedWidth,
    processedHeight,
    geometryMode,
    cropGeometry,
    annulusGeometry,
    regionMode,
    shapes,
    step,
    needsProcessedPreview,
  ]);

  useEffect(() => {
    samplesRef.current = samples;
  }, [samples]);

  useEffect(() => {
    if (tilingEnabled || !processedMask) return;
    const canvas = processedMaskPreviewRef.current;
    if (!canvas) return;

    const renderOverlay = () => {
      const displayWidth = Math.max(1, Math.round(canvas.clientWidth));
      const displayHeight = Math.max(1, Math.round(canvas.clientHeight));
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(displayWidth * pixelRatio);
      canvas.height = Math.round(displayHeight * pixelRatio);
      const context = canvas.getContext("2d");
      if (!context) return;

      const { width, height, pixels } = processedMask;
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskContext = maskCanvas.getContext("2d");
      if (!maskContext) return;
      const maskImage = maskContext.createImageData(width, height);
      for (let index = 0; index < pixels.length; index += 1) {
        if (!pixels[index]) continue;
        const rgbaIndex = index * 4;
        maskImage.data[rgbaIndex] = 76;
        maskImage.data[rgbaIndex + 1] = 139;
        maskImage.data[rgbaIndex + 2] = 105;
        maskImage.data[rgbaIndex + 3] = 41;
      }
      maskContext.putImageData(maskImage, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);

      context.scale(pixelRatio, pixelRatio);
      const displayX = (x: number) => (x / width) * displayWidth;
      const displayY = (y: number) => (y / height) * displayHeight;
      const isValid = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height
          ? pixels[y * width + x] > 0
          : false;
      const segmentsByCase: Record<number, [number, number][]> = {
        1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]],
        5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]],
        8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]],
        11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]],
      };
      context.beginPath();
      for (let y = -1; y < height; y += 1) {
        for (let x = -1; x < width; x += 1) {
          const contourCase =
            (isValid(x, y) ? 1 : 0) |
            (isValid(x + 1, y) ? 2 : 0) |
            (isValid(x + 1, y + 1) ? 4 : 0) |
            (isValid(x, y + 1) ? 8 : 0);
          const segments = segmentsByCase[contourCase];
          if (!segments) continue;
          const points = [
            [displayX(x + 1), displayY(y + 0.5)],
            [displayX(x + 1.5), displayY(y + 1)],
            [displayX(x + 1), displayY(y + 1.5)],
            [displayX(x + 0.5), displayY(y + 1)],
          ];
          for (const [start, end] of segments) {
            context.moveTo(points[start][0], points[start][1]);
            context.lineTo(points[end][0], points[end][1]);
          }
        }
      }
      context.strokeStyle = "rgba(76, 139, 105, 0.9)";
      context.lineWidth = 1.5;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    };

    renderOverlay();
    const resizeObserver = new ResizeObserver(renderOverlay);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [processedMask, tilingEnabled]);

  useEffect(() => {
    return () => {
      samplesRef.current.forEach((sample) => URL.revokeObjectURL(sample.url));
    };
  }, []);

  useEffect(() => {
    // Drafts are intentionally session-only. Remove data written by older
    // versions of the studio so a reload always starts from the defaults.
    window.localStorage.removeItem("profile-studio-draft");

    const confirmDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };

    window.addEventListener("beforeunload", confirmDiscard);
    return () => window.removeEventListener("beforeunload", confirmDiscard);
  }, []);

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
    const draftPolygon = polygonDraftRef.current?.getPoints() ?? [];
    if (draftPolygon.length < 3) return;
    const nextShape: PolygonShape = {
      id: crypto.randomUUID(),
      type: "polygon",
      operation,
      name: `${operation === "include" ? "Included area" : "Excluded area"} ${shapes.length + 1}`,
      points: draftPolygon,
    };
    updateShapes([...shapes, nextShape]);
    polygonDraftRef.current?.clear();
    setSelectedShapeId(nextShape.id);
    setTool("select");
  };

  const getCanvasPoint = (
    event:
      | ReactPointerEvent<SVGSVGElement>
      | ReactMouseEvent<SVGSVGElement>,
  ): Point => {
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
      const corner = (event.target as SVGElement).dataset.cropCorner as
        | CropCorner
        | undefined;
      const inside =
        point.x >= cropGeometry.x &&
        point.x <= cropGeometry.x + cropGeometry.width &&
        point.y >= cropGeometry.y &&
        point.y <= cropGeometry.y + cropGeometry.height;
      if (corner || inside) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragState({
          kind: "crop",
          corner,
          start: point,
          original: cropGeometry,
        });
      }
      return;
    }

    if (step === "geometry" && geometryMode === "annulus") {
      const controlElement = (event.target as Element).closest<SVGElement>(
        "[data-annulus-control]",
      );
      const control = controlElement?.dataset.annulusControl as
        | AnnulusControl
        | undefined;
      const distance = Math.hypot(
        point.x - annulusGeometry.cx,
        point.y - annulusGeometry.cy,
      );
      const insideOuterCircle = distance <= annulusGeometry.outerRadius;
      if (control || insideOuterCircle) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragState({
          kind: "annulus",
          control: control ?? "move",
          start: point,
          original: annulusGeometry,
        });
      }
      return;
    }

    if (step === "region" && regionMode === "dynamic") {
      const controlElement = (event.target as Element).closest<SVGElement>(
        "[data-dynamic-control]",
      );
      const control = controlElement?.dataset.dynamicControl as
        | DynamicEllipseControl
        | undefined;
      const distance = Math.hypot(
        point.x - dynamicCenter.x,
        point.y - dynamicCenter.y,
      );
      const insideOuterCircle = distance <= dynamicMax / 2;
      if (control || insideOuterCircle) {
        dynamicCustomizedRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragState({
          kind: "dynamic-ellipse",
          control: control ?? "move",
          start: point,
          originalCenter: dynamicCenter,
          originalMin: dynamicMin,
          originalMax: dynamicMax,
        });
      }
      return;
    }

    if (step !== "region" || regionMode !== "static") return;

    if (tool === "polygon") {
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

  const handleCanvasClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (
      step !== "region" ||
      regionMode !== "static" ||
      tool !== "polygon" ||
      event.detail !== 1
    ) {
      return;
    }
    polygonDraftRef.current?.addPoint(getCanvasPoint(event));
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
      if (dragState.corner) {
        const originalLeft = dragState.original.x;
        const originalTop = dragState.original.y;
        const originalRight = originalLeft + dragState.original.width;
        const originalBottom = originalTop + dragState.original.height;
        const movesLeft = dragState.corner.endsWith("west");
        const movesTop = dragState.corner.startsWith("north");
        const left = safeInteger(
          movesLeft
            ? clamp(originalLeft + dx, 0, originalRight - 1)
            : originalLeft,
        );
        const right = safeInteger(
          movesLeft
            ? originalRight
            : clamp(originalRight + dx, originalLeft + 1, sourceWidth),
        );
        const top = safeInteger(
          movesTop
            ? clamp(originalTop + dy, 0, originalBottom - 1)
            : originalTop,
        );
        const bottom = safeInteger(
          movesTop
            ? originalBottom
            : clamp(originalBottom + dy, originalTop + 1, sourceHeight),
        );

        setCropGeometry({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        });
        return;
      }

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
      if (dragState.control !== "move") {
        const radius = Math.hypot(
          point.x - dragState.original.cx,
          point.y - dragState.original.cy,
        );

        if (dragState.control === "inner-radius") {
          const innerRadius = safeInteger(
            clamp(radius, 1, dragState.original.outerRadius - 1),
          );
          setAnnulusGeometry({
            ...dragState.original,
            innerRadius,
            ...(stripCustomizedRef.current
              ? {}
              : recommendedAnnulusStrip(innerRadius, dragState.original.outerRadius)),
          });
          return;
        }

        const maximumRadius = Math.min(
          dragState.original.cx,
          sourceWidth - dragState.original.cx,
          dragState.original.cy,
          sourceHeight - dragState.original.cy,
        );
        const outerRadius = safeInteger(
          clamp(radius, dragState.original.innerRadius + 1, maximumRadius),
        );
        setAnnulusGeometry({
          ...dragState.original,
          outerRadius,
          ...(stripCustomizedRef.current
            ? {}
            : recommendedAnnulusStrip(dragState.original.innerRadius, outerRadius)),
        });
        return;
      }

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

    if (dragState.kind === "dynamic-ellipse") {
      if (dragState.control !== "move") {
        const diameter =
          Math.hypot(
            point.x - dragState.originalCenter.x,
            point.y - dragState.originalCenter.y,
          ) * 2;
        if (dragState.control === "minimum") {
          setDynamicMin(
            safeInteger(clamp(diameter, 1, dragState.originalMax - 1)),
          );
        } else {
          const maximumDiameter =
            Math.min(
              dragState.originalCenter.x,
              sourceWidth - dragState.originalCenter.x,
              dragState.originalCenter.y,
              sourceHeight - dragState.originalCenter.y,
            ) * 2;
          setDynamicMax(
            safeInteger(
              clamp(diameter, dragState.originalMin + 1, maximumDiameter),
            ),
          );
        }
        return;
      }

      const radius = dragState.originalMax / 2;
      setDynamicCenter({
        x: safeInteger(
          clamp(dragState.originalCenter.x + dx, radius, sourceWidth - radius),
        ),
        y: safeInteger(
          clamp(
            dragState.originalCenter.y + dy,
            radius,
            sourceHeight - radius,
          ),
        ),
      });
      return;
    }

    if (dragState.kind === "polygon-point") {
      setShapes((current) =>
        current.map((shape) =>
          shape.id === dragState.shapeId && shape.type === "polygon"
            ? {
                ...dragState.original,
                points: dragState.original.points.map((vertex, index) =>
                  index === dragState.pointIndex ? point : vertex,
                ),
              }
            : shape,
        ),
      );
      return;
    }

    if (dragState.kind === "ellipse-radius") {
      setShapes((current) =>
        current.map((shape) => {
          if (shape.id !== dragState.shapeId || shape.type !== "ellipse")
            return shape;
          return dragState.axis === "horizontal"
            ? {
                ...dragState.original,
                rx: Math.abs(point.x - dragState.original.cx),
              }
            : {
                ...dragState.original,
                ry: Math.abs(point.y - dragState.original.cy),
              };
        }),
      );
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

    if (
      dragState?.kind === "shape" ||
      dragState?.kind === "polygon-point" ||
      dragState?.kind === "ellipse-radius"
    ) {
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
    svg.setPointerCapture(event.pointerId);
    const bounds = svg.getBoundingClientRect();
    const start = {
      x: ((event.clientX - bounds.left) / bounds.width) * sourceWidth,
      y: ((event.clientY - bounds.top) / bounds.height) * sourceHeight,
    };
    setDragState({ kind: "shape", shapeId: shape.id, start, original: shape });
  };

  const startPolygonPointDrag = (
    event: ReactPointerEvent<SVGCircleElement>,
    shape: PolygonShape,
    pointIndex: number,
  ) => {
    if (tool !== "select" || step !== "region") return;
    event.stopPropagation();
    const start = {
      x: shape.points[pointIndex].x,
      y: shape.points[pointIndex].y,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
    setSelectedShapeId(shape.id);
    setDragState({
      kind: "polygon-point",
      shapeId: shape.id,
      pointIndex,
      start,
      original: shape,
    });
  };

  const startEllipseRadiusDrag = (
    event: ReactPointerEvent<SVGCircleElement>,
    shape: EllipseShape,
    axis: EllipseAxis,
  ) => {
    if (tool !== "select" || step !== "region") return;
    event.stopPropagation();
    const start = {
      x: axis === "horizontal" ? shape.cx + shape.rx : shape.cx,
      y: axis === "vertical" ? shape.cy + shape.ry : shape.cy,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
    setSelectedShapeId(shape.id);
    setDragState({
      kind: "ellipse-radius",
      shapeId: shape.id,
      axis,
      start,
      original: shape,
    });
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

  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setUploadMessage(null);

    let loaded: SampleImage[];
    try {
      loaded = await Promise.all(
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
                reject(new Error(`Could not read ${file.name}. Choose a supported file format.`));
              };
              image.src = url;
            }),
        ),
      );
    } catch (error) {
      setUploadMessage({
        message:
          error instanceof Error
            ? error.message
            : "Could not read the selected images.",
        tone: "error",
      });
      event.target.value = "";
      return;
    }

    const first = loaded[0];
    const expected = samples[0] ?? first;
    const dimensionsMatch = loaded.every(
      (sample) =>
        sample.width === expected.width && sample.height === expected.height,
    );
    if (!dimensionsMatch) {
      loaded.forEach((sample) => URL.revokeObjectURL(sample.url));
      setUploadMessage({
        message: "All reference images must have the same dimensions.",
        tone: "error",
      });
      event.target.value = "";
      return;
    }

    setSamples((current) => [...current, ...loaded]);
    setActiveSampleId(first.id);
    if (!samples.length) {
      setFallbackSourceSize({ width: first.width, height: first.height });
      const cropWidth = Math.max(1, Math.round(first.width * 0.62));
      const cropHeight = Math.max(1, Math.round(first.height * 0.72));
      setCropGeometry({
        x: Math.round((first.width - cropWidth) / 2),
        y: Math.round((first.height - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      });
      const outerRadius = Math.round(Math.min(first.width, first.height) * 0.36);
      const innerRadius = Math.round(outerRadius * 0.62);
      const strip = recommendedAnnulusStrip(innerRadius, outerRadius);
      setAnnulusGeometry((value) => ({
        ...value,
        cx: Math.round(first.width / 2),
        cy: Math.round(first.height / 2),
        innerRadius,
        outerRadius,
        ...strip,
      }));
      const dynamicRange = recommendedDynamicRange(cropWidth, cropHeight);
      setDynamicMin(dynamicRange.minimum);
      setDynamicMax(dynamicRange.maximum);
      setDynamicCenter({
        x: Math.round(first.width / 2),
        y: Math.round(first.height / 2),
      });
      if (tilingEnabled && !tilingCustomizedRef.current) {
        applyRecommendedTiling(cropWidth, cropHeight, "crop");
      }
      if (!artifactCustomizedRef.current) {
        setArtifactWidth(Math.min(1024, first.width));
        setArtifactHeight(Math.min(1024, first.height));
      }
      setShapes([]);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedShapeId(null);
    }
    event.target.value = "";
  };

  const applyImportedProfile = (parsed: unknown) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Profile JSON must contain an object at the top level.");
      }
      const data = parsed as Record<string, unknown>;
      const supportedFields = new Set([
        "name",
        "model_input_size",
        "preprocess_steps",
        "postprocess_steps",
        "tiling",
        "valid_region",
        "artifacts",
      ]);
      const unsupportedField = Object.keys(data).find((key) => !supportedFields.has(key));
      if (unsupportedField) {
        throw new Error(`${unsupportedField} is not a supported profile field.`);
      }
      if (typeof data.name !== "string") {
        throw new Error("name must be a string.");
      }
      const [inputWidthValue, inputHeightValue] = parseNamedNumberPair(
        data.model_input_size,
        "model_input_size",
        "width",
        "height",
      );
      modelInputCustomizedRef.current = true;
      stripCustomizedRef.current = false;
      dynamicCustomizedRef.current = false;
      setProfileName(data.name);
      setInputHeight(inputHeightValue);
      setInputWidth(inputWidthValue);
      setFallbackSourceSize({
        width: DEFAULT_CANVAS_WIDTH,
        height: DEFAULT_CANVAS_HEIGHT,
      });

      if (data.preprocess_steps !== undefined && !Array.isArray(data.preprocess_steps)) {
        throw new Error("preprocess_steps must be an array.");
      }
      const preprocess = (data.preprocess_steps ?? []) as unknown[];
      const firstStep = preprocess[0];
      const firstStepObject = firstStep === undefined ? undefined : parseObject(firstStep, "preprocess_steps[0]");
      if (firstStepObject?.name === "crop") {
        const params = parseObject(firstStepObject.params, "crop params");
        setGeometryMode("crop");
        setCropGeometry({
          x: parseNumber(params.x, "crop x"),
          y: parseNumber(params.y, "crop y"),
          width: parseNumber(params.width, "crop width"),
          height: parseNumber(params.height, "crop height"),
        });
      } else if (firstStepObject?.name === "annulus_unwrap") {
        const params = parseObject(firstStepObject.params, "annulus_unwrap params");
        const [centerX, centerY] = parseNamedNumberPair(
          params.center,
          "annulus center",
          "x",
          "y",
        );
        const [innerRadius, outerRadius] = parseNamedNumberPair(
          params.radii,
          "annulus radii",
          "inner",
          "outer",
        );
        const [stripWidth, stripHeight] = parseNamedNumberPair(
          params.strip_size,
          "annulus strip_size",
          "width",
          "height",
        );
        setGeometryMode("annulus");
        setAnnulusGeometry({
          cx: centerX,
          cy: centerY,
          innerRadius,
          outerRadius,
          stripHeight,
          stripWidth,
        });
        stripCustomizedRef.current = true;
      } else if (firstStepObject) {
        throw new Error(`Unsupported first preprocessing step: ${String(firstStepObject.name)}.`);
      } else {
        setGeometryMode("full");
      }

      if (data.postprocess_steps !== undefined && !Array.isArray(data.postprocess_steps)) {
        throw new Error("postprocess_steps must be an array.");
      }
      const postprocess = (data.postprocess_steps ?? []) as unknown[];
      const lastStep = postprocess.at(-1);
      const lastStepObject = lastStep === undefined
        ? undefined
        : parseObject(lastStep, `postprocess_steps[${postprocess.length - 1}]`);
      if (lastStepObject?.name === "crop_restore") {
        const params = parseObject(lastStepObject.params, "crop_restore params");
        const [imageWidth, imageHeight] = parseNamedNumberPair(
          params.image_size,
          "crop_restore image_size",
          "width",
          "height",
        );
        setFallbackSourceSize({ width: imageWidth, height: imageHeight });
      } else if (lastStepObject?.name === "annulus_wrap") {
        const params = parseObject(lastStepObject.params, "annulus_wrap params");
        parseNamedNumberPair(params.center, "annulus_wrap center", "x", "y");
        parseNamedNumberPair(params.radii, "annulus_wrap radii", "inner", "outer");
        const [imageWidth, imageHeight] = parseNamedNumberPair(
          params.image_size,
          "annulus_wrap image_size",
          "width",
          "height",
        );
        setFallbackSourceSize({ width: imageWidth, height: imageHeight });
      } else if (lastStepObject) {
        throw new Error(`Unsupported last postprocessing step: ${String(lastStepObject.name)}.`);
      }

      const validRegion = data.valid_region === undefined
        ? undefined
        : parseObject(data.valid_region, "valid_region");
      if (!validRegion) setRegionMode("none");
      else if (validRegion.type === "ellipse") {
        dynamicCustomizedRef.current = true;
        setRegionMode("dynamic");
        const [minimumDiameter, maximumDiameter] = parseNamedNumberPair(
          validRegion.diameter,
          "valid_region.diameter",
          "min",
          "max",
        );
        setDynamicMin(minimumDiameter);
        setDynamicMax(maximumDiameter);
      } else if (validRegion.type === "mask") {
        if (typeof validRegion.path !== "string" || !validRegion.path.trim()) {
          throw new Error("valid_region.path must be a non-empty string.");
        }
        setRegionMode("static");
        setShapes([]);
        setUndoStack([]);
        setRedoStack([]);
        setSelectedShapeId(null);
        setMaskName(validRegion.path);
      } else {
        throw new Error("valid_region.type must be mask or ellipse.");
      }

      const tiling = data.tiling === undefined ? undefined : parseObject(data.tiling, "tiling");
      tilingCustomizedRef.current = Boolean(tiling);
      setTilingEnabled(Boolean(tiling));
      if (tiling) {
        const [tileWidthValue, tileHeightValue] = parseNamedNumberPair(
          tiling.tile_size,
          "tiling.tile_size",
          "width",
          "height",
        );
        const [strideX, strideY] = parseNamedNumberPair(
          tiling.stride,
          "tiling.stride",
          "x",
          "y",
        );
        setTileHeight(tileHeightValue);
        setTileWidth(tileWidthValue);
        setStrideHeight(strideY);
        setStrideWidth(strideX);
      }

      const artifacts = data.artifacts === undefined
        ? undefined
        : parseObject(data.artifacts, "artifacts");
      if (artifacts && (Object.keys(artifacts).length !== 1 || !("size" in artifacts))) {
        throw new Error("artifacts must contain only size.");
      }
      const artifact = artifacts === undefined
        ? undefined
        : parseObject(artifacts.size, "artifacts.size");
      setArtifactEnabled(Boolean(artifact));
      artifactCustomizedRef.current = Boolean(artifact);
      if (artifact) {
        if (artifact.max_width === undefined && artifact.max_height === undefined) {
          throw new Error("artifacts.size must define max_width or max_height.");
        }
        setArtifactWidth(
          artifact.max_width === undefined
            ? 1024
            : parseNumber(artifact.max_width, "artifacts.size.max_width"),
        );
        setArtifactHeight(
          artifact.max_height === undefined
            ? 1024
            : parseNumber(artifact.max_height, "artifacts.size.max_height"),
        );
      }
      setStaticMaskNeedsRedraw(validRegion?.type === "mask");
      setStep("review");
  };

  const handleImport = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportMessage(null);
    let importedSamples: SampleImage[] = [];
    try {
      if (!file.name.toLocaleLowerCase().endsWith(".zip")) {
        applyImportedProfile(JSON.parse(await file.text()) as unknown);
        return;
      }

      const zip = await JSZip.loadAsync(file);
      const projectEntry = zip.file("studio/project.json");
      if (!projectEntry) {
        throw new Error("The ZIP does not contain studio/project.json.");
      }
      const project = parseStudioProject(
        JSON.parse(await projectEntry.async("string")) as unknown,
      );
      const profileEntry = zip.file(project.profilePath);
      if (!profileEntry) {
        throw new Error(`The ZIP does not contain ${project.profilePath}.`);
      }
      const parsedProfile = JSON.parse(await profileEntry.async("string")) as unknown;
      const profileObject = parseObject(parsedProfile, "profile");
      const validRegion = profileObject.valid_region;
      if (validRegion) {
        const validRegionObject = parseObject(validRegion, "valid_region");
        if (validRegionObject.type === "mask") {
          const maskPath = parseString(validRegionObject.path, "valid_region.path");
          if (!isSafeZipPath(maskPath)) {
            throw new Error("valid_region.path is not safe.");
          }
          const archivedMaskPath = `dataset/valid_regions/${maskPath}`;
          if (!zip.file(archivedMaskPath)) {
            throw new Error(`The ZIP does not contain ${archivedMaskPath}.`);
          }
        }
      }

      const referencePaths = new Set<string>();
      for (const reference of project.references) {
        if (referencePaths.has(reference.path)) {
          throw new Error(`Reference image path ${reference.path} is used more than once.`);
        }
        referencePaths.add(reference.path);
        const entry = zip.file(reference.path);
        if (!entry) {
          throw new Error(`The ZIP does not contain ${reference.path}.`);
        }
        const bytes = await entry.async("uint8array");
        if (bytes.byteLength !== reference.bytes) {
          throw new Error(`${reference.name} does not match its saved file size.`);
        }
        const blob = new Blob([bytes], { type: reference.mediaType });
        importedSamples.push(await loadReferenceImage(blob, reference));
      }

      const dimensionsMatch = importedSamples.every(
        (sample) =>
          sample.width === project.sourceSize.width &&
          sample.height === project.sourceSize.height,
      );
      if (!dimensionsMatch) {
        throw new Error("Reference images do not match the saved source size.");
      }

      applyImportedProfile(parsedProfile);
      samplesRef.current.forEach((sample) => URL.revokeObjectURL(sample.url));
      samplesRef.current = importedSamples;
      setSamples(importedSamples);
      setActiveSampleId(project.activeReferenceId ?? importedSamples[0]?.id ?? null);
      setFallbackSourceSize(project.sourceSize);
      setShapes(project.shapes);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedShapeId(null);
      setDynamicCenter(project.dynamicCenter);
      stripCustomizedRef.current = project.customized.strip;
      tilingCustomizedRef.current = project.customized.tiling;
      dynamicCustomizedRef.current = project.customized.dynamic;
      modelInputCustomizedRef.current = project.customized.modelInput;
      artifactCustomizedRef.current = project.customized.artifact;
      setStaticMaskNeedsRedraw(
        Boolean(
          validRegion &&
            parseObject(validRegion, "valid_region").type === "mask" &&
            project.shapes.length === 0,
        ),
      );
      setStep(project.step);
      importedSamples = [];
    } catch (error) {
      importedSamples.forEach((sample) => URL.revokeObjectURL(sample.url));
      setImportMessage({
        message:
          error instanceof SyntaxError
            ? "The selected file contains malformed JSON."
            : error instanceof Error
              ? `Could not import profile or project: ${error.message}`
              : "That file is not a valid profile or Studio project.",
        tone: "error",
      });
    } finally {
      event.target.value = "";
    }
  };

  const tilingTiles = useMemo(() => {
    if (
      !tilingEnabled ||
      tileHeight <= 0 ||
      tileWidth <= 0 ||
      strideHeight <= 0 ||
      strideWidth <= 0 ||
      processedHeight <= 0 ||
      processedWidth <= 0 ||
      tileHeight > processedHeight ||
      tileWidth > processedWidth
    ) {
      return [];
    }

    const rows = Math.min(
      Math.max(
        1,
        Math.ceil((processedHeight - tileHeight) / strideHeight) + 1,
      ),
      Math.ceil(processedHeight / strideHeight),
    );
    const columns = Math.min(
      Math.max(
        1,
        Math.ceil((processedWidth - tileWidth) / strideWidth) + 1,
      ),
      Math.ceil(processedWidth / strideWidth),
    );
    const integral = new Uint32Array((processedWidth + 1) * (processedHeight + 1));
    const hasStaticMask =
      regionMode === "static" &&
      processedMask?.width === processedWidth &&
      processedMask.height === processedHeight;
    if (hasStaticMask && processedMask) {
      for (let y = 1; y <= processedHeight; y += 1) {
        let rowSum = 0;
        for (let x = 1; x <= processedWidth; x += 1) {
          rowSum += processedMask.pixels[(y - 1) * processedWidth + x - 1];
          integral[y * (processedWidth + 1) + x] =
            integral[(y - 1) * (processedWidth + 1) + x] + rowSum;
        }
      }
    }
    const tiles = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = column * strideWidth;
        const y = row * strideHeight;
        const right = Math.min(x + tileWidth, processedWidth);
        const bottom = Math.min(y + tileHeight, processedHeight);
        const valid =
          regionMode !== "static"
            ? tileWidth * tileHeight
            : hasStaticMask
              ? integral[bottom * (processedWidth + 1) + right] -
                integral[y * (processedWidth + 1) + right] -
                integral[bottom * (processedWidth + 1) + x] +
                integral[y * (processedWidth + 1) + x]
              : 0;
        const coverage = valid / (tileWidth * tileHeight);
        tiles.push({
          id: row * columns + column + 1,
          x,
          y,
          width: tileWidth,
          height: tileHeight,
          included: coverage >= 0.3,
          coverage,
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
    processedHeight,
    processedWidth,
    regionMode,
    processedMask,
  ]);

  const geometryIssue = useMemo(() => {
    if (geometryMode === "full") return null;
    if (geometryMode === "crop") {
      if (![cropGeometry.x, cropGeometry.y, cropGeometry.width, cropGeometry.height].every(Number.isInteger)) {
        return "Crop values must be whole pixels.";
      }
      if (cropGeometry.x < 0) return "Crop X must be zero or greater.";
      if (cropGeometry.y < 0) return "Crop Y must be zero or greater.";
      if (cropGeometry.width <= 0) return "Crop width must be greater than zero.";
      if (cropGeometry.height <= 0) return "Crop height must be greater than zero.";
      if (cropGeometry.x + cropGeometry.width > sourceWidth) {
        return `Crop exceeds the source width by ${cropGeometry.x + cropGeometry.width - sourceWidth} px.`;
      }
      if (cropGeometry.y + cropGeometry.height > sourceHeight) {
        return `Crop exceeds the source height by ${cropGeometry.y + cropGeometry.height - sourceHeight} px.`;
      }
      return null;
    }
    if (![
      annulusGeometry.cx,
      annulusGeometry.cy,
      annulusGeometry.innerRadius,
      annulusGeometry.outerRadius,
      annulusGeometry.stripHeight,
      annulusGeometry.stripWidth,
    ].every(Number.isInteger)) return "Annulus values must be whole pixels.";
    if (annulusGeometry.innerRadius <= 0) return "Inner radius must be greater than zero.";
    if (annulusGeometry.outerRadius <= annulusGeometry.innerRadius) {
      return "Outer radius must be greater than inner radius.";
    }
    if (
      annulusGeometry.cx - annulusGeometry.outerRadius < 0 ||
      annulusGeometry.cx + annulusGeometry.outerRadius > sourceWidth
    ) {
      return "The outer circle must fit within the source width.";
    }
    if (
      annulusGeometry.cy - annulusGeometry.outerRadius < 0 ||
      annulusGeometry.cy + annulusGeometry.outerRadius > sourceHeight
    ) {
      return "The outer circle must fit within the source height.";
    }
    if (annulusGeometry.stripHeight <= 0 || annulusGeometry.stripWidth <= 0) {
      return "Unwrapped strip dimensions must be greater than zero.";
    }
    return null;
  }, [geometryMode, cropGeometry, annulusGeometry, sourceWidth, sourceHeight]);

  const regionIssue = useMemo(() => {
    if (regionMode === "none") return null;
    if (regionMode === "dynamic") {
      if (![dynamicMin, dynamicMax].every(Number.isInteger)) {
        return "Ellipse diameters must be whole pixels.";
      }
      if (dynamicMin <= 0) return "Minimum diameter must be greater than zero.";
      if (dynamicMax <= dynamicMin) return "Maximum diameter must be greater than minimum.";
      return null;
    }
    if (hasDraftPolygon) {
      return "Finish or cancel the unfinished polygon.";
    }
    if (!shapes.some((shape) => shape.operation === "include")) {
      return "Draw at least one Include shape to define an inspection area.";
    }
    if (staticMaskHasPixels === false) {
      return "The final mask has no inspection pixels after exclusions and preprocessing.";
    }
    if (!maskName.trim()) return "Mask filename is required.";
    if (maskName.includes("/") || maskName.includes("\\")) {
      return "Mask filename cannot contain path separators.";
    }
    if (!maskName.toLowerCase().endsWith(".png")) {
      return "Mask filename must end with .png.";
    }
    return null;
  }, [
    regionMode,
    dynamicMin,
    dynamicMax,
    hasDraftPolygon,
    shapes,
    maskName,
    staticMaskHasPixels,
  ]);

  const modelInputIssue = ![inputHeight, inputWidth].every(Number.isInteger)
    ? "Model input dimensions must be whole pixels."
    : inputHeight <= 0 || inputWidth <= 0
      ? "Model input dimensions must be greater than zero."
      : null;
  const tileIssue = !tilingEnabled
    ? null
    : ![tileHeight, tileWidth].every(Number.isInteger)
      ? "Tile dimensions must be whole pixels."
      : tileHeight <= 0 || tileWidth <= 0
        ? "Tile dimensions must be greater than zero."
        : tileHeight > processedHeight
          ? `Tile height cannot exceed the processed height (${processedHeight} px).`
          : tileWidth > processedWidth
            ? `Tile width cannot exceed the processed width (${processedWidth} px).`
            : null;
  const strideIssue = !tilingEnabled
    ? null
    : ![strideHeight, strideWidth].every(Number.isInteger)
      ? "Stride dimensions must be whole pixels."
      : strideHeight <= 0 || strideWidth <= 0
        ? "Stride dimensions must be greater than zero."
        : strideHeight > tileHeight
          ? "Height stride cannot exceed tile height because it would leave uninspected gaps."
          : strideWidth > tileWidth
            ? "Width stride cannot exceed tile width because it would leave uninspected gaps."
            : null;
  const coverageIssue = tilingEnabled && !tileIssue && !strideIssue && !tilingTiles.some((tile) => tile.included)
    ? "No tile reaches the required 30% valid-region coverage."
    : null;
  const artifactIssue = !artifactEnabled
    ? null
    : ![artifactWidth, artifactHeight].every(Number.isInteger)
      ? "Output image maximum dimensions must be whole pixels."
      : artifactWidth <= 0 || artifactHeight <= 0
        ? "Output image maximum dimensions must be greater than zero."
        : null;
  const profileNameIssue = !profileName.trim()
    ? "Profile name is required."
    : [".", ".."].includes(profileName.trim())
      ? "Profile name cannot be “.” or “..”."
      : profileName.includes("/") || profileName.includes("\\")
        ? "Profile name cannot contain path separators."
        : null;
  const reviewMessage: ContextMessage | null =
    staticMaskNeedsRedraw &&
    regionMode === "static" &&
    !shapes.some((shape) => shape.operation === "include")
      ? {
          message:
            "Static mask drawings are not stored in profile JSON. Redraw the inspection area before exporting.",
          tone: "warning",
        }
      : null;

  const validation = useMemo(() => {
    const checks: ValidationCheck[] = [];
    checks.push({
      ok: !profileNameIssue,
      label: profileNameIssue ?? "Profile name and filename are valid",
      step: "review",
    });
    checks.push({
      ok: samples.length > 0,
      label:
        samples.length === 0
          ? "Add at least one reference image"
          : `${samples.length} reference sample${samples.length === 1 ? "" : "s"} aligned`,
      step: "samples",
    });
    checks.push({
      ok: !geometryIssue,
      label: geometryIssue ?? (geometryMode === "full" ? "Full image geometry selected" : "Geometry fits the source"),
      step: "geometry",
    });
    checks.push({
      ok: !regionIssue,
      label: regionIssue ?? (regionMode === "static" ? "Valid-region mask includes an inspection area" : regionMode === "dynamic" ? "Dynamic ellipse diameter range is valid" : "Entire processed image is valid"),
      step: "region",
    });
    checks.push({
      ok: !modelInputIssue,
      label: modelInputIssue ?? "Model input size is valid",
      step: "model",
    });
    if (tilingEnabled) {
      checks.push({
        ok: !tileIssue,
        label: tileIssue ?? "Tile dimensions fit the processed image",
        step: "model",
      });
      checks.push({
        ok: !strideIssue,
        label: strideIssue ?? "Stride leaves no uninspected gaps",
        step: "model",
      });
    }
    if (artifactEnabled) {
      checks.push({
        ok: !artifactIssue,
        label: artifactIssue ?? "Output image maximum size is valid",
        step: "model",
      });
    }
    if (tilingEnabled) {
      checks.push({
        ok: !coverageIssue,
        label: coverageIssue ?? `${tilingTiles.filter((tile) => tile.included).length} of ${tilingTiles.length} tiles included`,
        step: "model",
      });
    }
    return checks;
  }, [
    profileNameIssue,
    samples,
    geometryMode,
    geometryIssue,
    regionMode,
    regionIssue,
    tilingEnabled,
    tilingTiles,
    modelInputIssue,
    tileIssue,
    strideIssue,
    coverageIssue,
    artifactEnabled,
    artifactIssue,
  ]);

  const profile = useMemo(() => {
    const output: Record<string, unknown> = {
      name: slugify(profileName),
      preprocess_steps: [],
      postprocess_steps: [],
      model_input_size: {
        width: safeInteger(inputWidth),
        height: safeInteger(inputHeight),
      },
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
            image_size: {
              width: sourceWidth,
              height: sourceHeight,
            },
            x: safeInteger(cropGeometry.x),
            y: safeInteger(cropGeometry.y),
            width: safeInteger(cropGeometry.width),
            height: safeInteger(cropGeometry.height),
          },
        },
      ];
    } else if (geometryMode === "annulus") {
      const geometry = {
        center: {
          x: safeInteger(annulusGeometry.cx),
          y: safeInteger(annulusGeometry.cy),
        },
        radii: {
          inner: safeInteger(annulusGeometry.innerRadius),
          outer: safeInteger(annulusGeometry.outerRadius),
        },
      };
      output.preprocess_steps = [
        {
          name: "annulus_unwrap",
          params: {
            ...geometry,
            strip_size: {
              width: safeInteger(annulusGeometry.stripWidth),
              height: safeInteger(annulusGeometry.stripHeight),
            },
          },
        },
      ];
      output.postprocess_steps = [
        {
          name: "annulus_wrap",
          params: {
            ...geometry,
            image_size: {
              width: sourceWidth,
              height: sourceHeight,
            },
          },
        },
      ];
    }

    if (regionMode === "static") {
      output.valid_region = {
        type: "mask",
        path: maskName.trim() || DEFAULT_MASK_NAME,
      };
    } else if (regionMode === "dynamic") {
      output.valid_region = {
        type: "ellipse",
        diameter: {
          min: safeInteger(dynamicMin),
          max: safeInteger(dynamicMax),
        },
      };
    }

    if (tilingEnabled) {
      output.tiling = {
        tile_size: {
          width: safeInteger(tileWidth),
          height: safeInteger(tileHeight),
        },
        stride: {
          x: safeInteger(strideWidth),
          y: safeInteger(strideHeight),
        },
      };
    }

    if (artifactEnabled) {
      output.artifacts = {
        size: {
          max_width: safeInteger(artifactWidth),
          max_height: safeInteger(artifactHeight),
        },
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
    renderFinalMask(
      context,
      sourceWidth,
      sourceHeight,
      shapes,
      geometryMode,
      cropGeometry,
      annulusGeometry,
    );
    return canvasToBlob(canvas);
  };

  const exportBundle = async () => {
    if (validation.some((check) => !check.ok)) {
      setStep("review");
      return;
    }
    setExportMessage(null);
    setExporting(true);
    try {
      const zip = new JSZip();
      const resolvedProfileName = slugify(profileName);
      const resolvedMaskName = maskName.trim() || DEFAULT_MASK_NAME;
      const profilePath = `profiles/${resolvedProfileName}.json`;
      zip.file(
        profilePath,
        `${JSON.stringify(profile, null, 2)}\n`,
      );

      if (regionMode === "static") {
        zip.file(`dataset/valid_regions/${resolvedMaskName}`, await drawMask());
      }

      const usedReferenceNames = new Set<string>();
      const projectReferences: Array<{
        id: string;
        name: string;
        path: string;
        media_type: string;
        width: number;
        height: number;
        bytes: number;
      }> = [];
      for (const sample of samples) {
        const response = await fetch(sample.url);
        if (!response.ok) {
          throw new Error(`Could not read reference image ${sample.name}.`);
        }
        const blob = await response.blob();
        const filename = referenceFilename(sample.name, usedReferenceNames);
        const path = `studio/reference_images/${filename}`;
        zip.file(path, blob);
        projectReferences.push({
          id: sample.id,
          name: sample.name,
          path,
          media_type: blob.type || "application/octet-stream",
          width: sample.width,
          height: sample.height,
          bytes: blob.size,
        });
      }

      const studioProject = {
        profile_path: profilePath,
        source_size: {
          width: sourceWidth,
          height: sourceHeight,
        },
        reference_images: projectReferences,
        active_reference_id: activeSample?.id ?? null,
        static_region_shapes: shapes,
        dynamic_region_preview_center: dynamicCenter,
        step,
        customized: {
          strip: stripCustomizedRef.current,
          tiling: tilingCustomizedRef.current,
          dynamic: dynamicCustomizedRef.current,
          model_input: modelInputCustomizedRef.current,
          artifact: artifactCustomizedRef.current,
        },
      };
      zip.file(
        "studio/project.json",
        `${JSON.stringify(studioProject, null, 2)}\n`,
      );

      const bundle = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(bundle);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${resolvedProfileName}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportMessage({
        message:
          error instanceof Error ? error.message : "Could not export the bundle.",
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  };

  const selectedShape = shapes.find((shape) => shape.id === selectedShapeId);
  const activeTiles = tilingTiles.filter((tile) => tile.included);
  const stepNumber = STEPS.findIndex((item) => item.id === step) + 1;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Zap size={19} strokeWidth={2.3} />
          </div>
          <div>
            <div className="brand-name">Profile Studio</div>
            <div className="draft-status">{slugify(profileName)}</div>
          </div>
        </div>
        <div className="topbar-action-area">
          <div className="topbar-actions">
            <input
              ref={projectInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={handleImport}
            />
            <input
              ref={profileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={handleImport}
            />
            <button
              className="button button-secondary"
              type="button"
              onClick={() => projectInputRef.current?.click()}
            >
              <FolderArchive size={16} />
              Open project
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => profileInputRef.current?.click()}
            >
              <FileJson size={16} />
              Import profile
            </button>
          </div>
          {importMessage && (
            <div className="topbar-feedback">
              <FieldMessage
                message={importMessage.message}
                tone={importMessage.tone}
              />
            </div>
          )}
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

      <div className="workspace">
        <section className="editor-card">
          <div
            className={`image-stage ${tool !== "select" && step === "region" ? "drawing" : ""}`}
            style={{ aspectRatio: `${previewWidth} / ${previewHeight}` }}
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
                viewBox={`0 0 ${previewWidth} ${previewHeight}`}
                preserveAspectRatio="none"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerLeave={handleCanvasPointerUp}
                onClick={handleCanvasClick}
                onDoubleClick={() => {
                  if (
                    step === "region" &&
                    regionMode === "static" &&
                    tool === "polygon"
                  ) {
                    finishPolygon();
                  }
                }}
              >
              {(step === "model" || step === "review") &&
                regionMode === "static" &&
                !tilingEnabled && (
                  <defs>
                    <g id="valid-region-includes">
                      {shapes
                        .filter((shape) => shape.operation === "include")
                        .map((shape) =>
                          shape.type === "polygon" ? (
                            <polygon
                              key={shape.id}
                              points={shape.points
                                .map((point) => `${point.x},${point.y}`)
                                .join(" ")}
                            />
                          ) : (
                            <ellipse
                              key={shape.id}
                              cx={shape.cx}
                              cy={shape.cy}
                              rx={shape.rx}
                              ry={shape.ry}
                            />
                          ),
                        )}
                    </g>
                    <g id="valid-region-excludes">
                      {shapes
                        .filter((shape) => shape.operation === "exclude")
                        .map((shape) =>
                          shape.type === "polygon" ? (
                            <polygon
                              key={shape.id}
                              points={shape.points
                                .map((point) => `${point.x},${point.y}`)
                                .join(" ")}
                            />
                          ) : (
                            <ellipse
                              key={shape.id}
                              cx={shape.cx}
                              cy={shape.cy}
                              rx={shape.rx}
                              ry={shape.ry}
                            />
                          ),
                        )}
                    </g>
                    <g id="valid-region-geometry">
                      {geometryMode === "full" && (
                        <rect x={0} y={0} width={sourceWidth} height={sourceHeight} />
                      )}
                      {geometryMode === "crop" && (
                        <rect
                          x={cropGeometry.x}
                          y={cropGeometry.y}
                          width={cropGeometry.width}
                          height={cropGeometry.height}
                        />
                      )}
                      {geometryMode === "annulus" && (
                        <path
                          d={`M${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}Z M${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}Z`}
                          fillRule="evenodd"
                        />
                      )}
                    </g>
                    <mask
                      id="final-valid-region-mask"
                      x={0}
                      y={0}
                      width={sourceWidth}
                      height={sourceHeight}
                      maskUnits="userSpaceOnUse"
                      maskContentUnits="userSpaceOnUse"
                    >
                      <rect
                        x={0}
                        y={0}
                        width={sourceWidth}
                        height={sourceHeight}
                        fill="#000"
                      />
                      <use href="#valid-region-includes" fill="#fff" />
                      <use href="#valid-region-excludes" fill="#000" />
                    </mask>
                    <mask
                      id="inverse-valid-region-mask"
                      x={0}
                      y={0}
                      width={sourceWidth}
                      height={sourceHeight}
                      maskUnits="userSpaceOnUse"
                      maskContentUnits="userSpaceOnUse"
                    >
                      <rect x={0} y={0} width={sourceWidth} height={sourceHeight} fill="#fff" />
                      <use href="#valid-region-includes" fill="#000" />
                      <use href="#valid-region-excludes" fill="#fff" />
                    </mask>
                    <mask
                      id="valid-region-geometry-mask"
                      x={0}
                      y={0}
                      width={sourceWidth}
                      height={sourceHeight}
                      maskUnits="userSpaceOnUse"
                      maskContentUnits="userSpaceOnUse"
                    >
                      <rect x={0} y={0} width={sourceWidth} height={sourceHeight} fill="#000" />
                      <use href="#valid-region-geometry" fill="#fff" />
                    </mask>
                  </defs>
                )}

              {step === "geometry" &&
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
                      {
                        x: cropGeometry.x,
                        y: cropGeometry.y,
                        corner: "north-west" as const,
                      },
                      {
                        x: cropGeometry.x + cropGeometry.width,
                        y: cropGeometry.y,
                        corner: "north-east" as const,
                      },
                      {
                        x: cropGeometry.x,
                        y: cropGeometry.y + cropGeometry.height,
                        corner: "south-west" as const,
                      },
                      {
                        x: cropGeometry.x + cropGeometry.width,
                        y: cropGeometry.y + cropGeometry.height,
                        corner: "south-east" as const,
                      },
                    ].map(({ x, y, corner }) => (
                      <circle
                        key={corner}
                        cx={x}
                        cy={y}
                        r={Math.max(sourceWidth, sourceHeight) * 0.0075}
                        className="geometry-handle"
                        data-crop-corner={corner}
                      />
                    ))}
                  </g>
                )}

              {step === "geometry" &&
                geometryMode === "annulus" && (
                  <g className="annulus-overlay">
                    <path
                      d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}Z M${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}Z`}
                      fillRule="evenodd"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.outerRadius}
                      className="geometry-line"
                      data-annulus-control="move"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.innerRadius}
                      className="geometry-line"
                      data-annulus-control="move"
                    />
                    <circle
                      cx={annulusGeometry.cx + annulusGeometry.outerRadius}
                      cy={annulusGeometry.cy}
                      r={Math.max(sourceWidth, sourceHeight) * 0.0075}
                      className="geometry-handle"
                      data-annulus-control="outer-radius"
                    />
                    <circle
                      cx={annulusGeometry.cx + annulusGeometry.innerRadius}
                      cy={annulusGeometry.cy}
                      r={Math.max(sourceWidth, sourceHeight) * 0.0075}
                      className="geometry-handle"
                      data-annulus-control="inner-radius"
                    />
                  </g>
                )}

              {step === "region" && geometryMode === "crop" && (
                <g className="fixed-geometry-context">
                  <path
                    d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${cropGeometry.x} ${cropGeometry.y}H${cropGeometry.x + cropGeometry.width}V${cropGeometry.y + cropGeometry.height}H${cropGeometry.x}Z`}
                    fillRule="evenodd"
                  />
                  <rect
                    x={cropGeometry.x}
                    y={cropGeometry.y}
                    width={cropGeometry.width}
                    height={cropGeometry.height}
                    className="fixed-geometry-line"
                  />
                </g>
              )}

              {step === "region" && geometryMode === "annulus" && (
                <g className="fixed-geometry-context">
                  <path
                    d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}Z M${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}Z`}
                    fillRule="evenodd"
                  />
                  <circle
                    cx={annulusGeometry.cx}
                    cy={annulusGeometry.cy}
                    r={annulusGeometry.outerRadius}
                    className="fixed-geometry-line"
                  />
                  <circle
                    cx={annulusGeometry.cx}
                    cy={annulusGeometry.cy}
                    r={annulusGeometry.innerRadius}
                    className="fixed-geometry-line"
                  />
                  <line
                    x1={annulusGeometry.cx + annulusGeometry.innerRadius}
                    y1={annulusGeometry.cy}
                    x2={annulusGeometry.cx + annulusGeometry.outerRadius}
                    y2={annulusGeometry.cy}
                    className="annulus-seam"
                  />
                </g>
              )}

              {step === "region" &&
                regionMode === "static" && (
                  <g className="roi-shapes">
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
                          </g>
                        );
                      }
                      return (
                        <g key={shape.id}>
                          <ellipse
                            cx={shape.cx}
                            cy={shape.cy}
                            rx={shape.rx}
                            ry={shape.ry}
                            className={className}
                            onPointerDown={(event) =>
                              startShapeDrag(event, shape)
                            }
                          />
                        </g>
                      );
                    })}

                    {selectedShape?.type === "polygon" &&
                      selectedShape.points.map((point, index) => (
                        <circle
                          key={index}
                          cx={point.x}
                          cy={point.y}
                          r={Math.max(sourceWidth, sourceHeight) * 0.007}
                          className={`roi-handle ${selectedShape.operation}`}
                          onPointerDown={(event) =>
                            startPolygonPointDrag(event, selectedShape, index)
                          }
                        />
                      ))}

                    {selectedShape?.type === "ellipse" && (
                      <>
                        <circle
                          cx={selectedShape.cx + selectedShape.rx}
                          cy={selectedShape.cy}
                          r={Math.max(sourceWidth, sourceHeight) * 0.007}
                          className={`roi-handle horizontal ${selectedShape.operation}`}
                          onPointerDown={(event) =>
                            startEllipseRadiusDrag(
                              event,
                              selectedShape,
                              "horizontal",
                            )
                          }
                        />
                        <circle
                          cx={selectedShape.cx}
                          cy={selectedShape.cy + selectedShape.ry}
                          r={Math.max(sourceWidth, sourceHeight) * 0.007}
                          className={`roi-handle vertical ${selectedShape.operation}`}
                          onPointerDown={(event) =>
                            startEllipseRadiusDrag(
                              event,
                              selectedShape,
                              "vertical",
                            )
                          }
                        />
                      </>
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

              <PolygonDraftLayer
                ref={polygonDraftRef}
                operation={operation}
                handleRadius={Math.max(sourceWidth, sourceHeight) * 0.007}
                visible={step === "region" && regionMode === "static"}
                onActiveChange={setHasDraftPolygon}
              />

              {(step === "model" || step === "review") &&
                geometryMode === "crop" && (
                  <g className="fixed-geometry-context">
                    <path
                      d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${cropGeometry.x} ${cropGeometry.y}H${cropGeometry.x + cropGeometry.width}V${cropGeometry.y + cropGeometry.height}H${cropGeometry.x}Z`}
                      fillRule="evenodd"
                    />
                    <rect
                      x={cropGeometry.x}
                      y={cropGeometry.y}
                      width={cropGeometry.width}
                      height={cropGeometry.height}
                      className="fixed-geometry-line"
                    />
                  </g>
                )}

              {(step === "model" || step === "review") &&
                geometryMode === "annulus" && (
                  <g className="fixed-geometry-context">
                    <path
                      d={`M0 0H${sourceWidth}V${sourceHeight}H0Z M${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}Z M${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}Z`}
                      fillRule="evenodd"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.outerRadius}
                      className="fixed-geometry-line"
                    />
                    <circle
                      cx={annulusGeometry.cx}
                      cy={annulusGeometry.cy}
                      r={annulusGeometry.innerRadius}
                      className="fixed-geometry-line"
                    />
                    <line
                      x1={annulusGeometry.cx + annulusGeometry.innerRadius}
                      y1={annulusGeometry.cy}
                      x2={annulusGeometry.cx + annulusGeometry.outerRadius}
                      y2={annulusGeometry.cy}
                      className="annulus-seam"
                    />
                  </g>
                )}

              {(step === "model" || step === "review") &&
                regionMode === "static" &&
                !tilingEnabled && (
                  <g className="final-valid-region">
                    <g mask="url(#final-valid-region-mask)">
                      <use
                        href="#valid-region-geometry"
                        className="final-valid-region-fill"
                      />
                    </g>
                    <g mask="url(#valid-region-geometry-mask)">
                      <g mask="url(#inverse-valid-region-mask)">
                        {shapes
                          .filter((shape) => shape.operation === "include")
                          .map((shape) =>
                            shape.type === "polygon" ? (
                              <polygon
                                key={shape.id}
                                points={shape.points
                                  .map((point) => `${point.x},${point.y}`)
                                  .join(" ")}
                                className="final-valid-region-boundary"
                              />
                            ) : (
                              <ellipse
                                key={shape.id}
                                cx={shape.cx}
                                cy={shape.cy}
                                rx={shape.rx}
                                ry={shape.ry}
                                className="final-valid-region-boundary"
                              />
                            ),
                          )}
                      </g>
                      <g mask="url(#final-valid-region-mask)">
                        {shapes
                          .filter((shape) => shape.operation === "exclude")
                          .map((shape) =>
                            shape.type === "polygon" ? (
                              <polygon
                                key={shape.id}
                                points={shape.points
                                  .map((point) => `${point.x},${point.y}`)
                                  .join(" ")}
                                className="final-valid-region-boundary"
                              />
                            ) : (
                              <ellipse
                                key={shape.id}
                                cx={shape.cx}
                                cy={shape.cy}
                                rx={shape.rx}
                                ry={shape.ry}
                                className="final-valid-region-boundary"
                              />
                            ),
                          )}
                        {geometryMode === "full" && (
                          <rect
                            x={0}
                            y={0}
                            width={sourceWidth}
                            height={sourceHeight}
                            className="final-valid-region-boundary"
                          />
                        )}
                        {geometryMode === "crop" && (
                          <rect
                            x={cropGeometry.x}
                            y={cropGeometry.y}
                            width={cropGeometry.width}
                            height={cropGeometry.height}
                            className="final-valid-region-boundary"
                          />
                        )}
                        {geometryMode === "annulus" && (
                          <path
                            d={`M${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.outerRadius} ${annulusGeometry.cy}A${annulusGeometry.outerRadius} ${annulusGeometry.outerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.outerRadius} ${annulusGeometry.cy}Z M${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx - annulusGeometry.innerRadius} ${annulusGeometry.cy}A${annulusGeometry.innerRadius} ${annulusGeometry.innerRadius} 0 1 0 ${annulusGeometry.cx + annulusGeometry.innerRadius} ${annulusGeometry.cy}Z`}
                            fillRule="evenodd"
                            className="final-valid-region-boundary"
                          />
                        )}
                      </g>
                    </g>
                  </g>
                )}

              {(step === "model" || step === "review") && tilingEnabled && (
                <g className="tiling-overlay">
                  {tilingTiles.map((tile) => {
                    const tileClassName = `tile ${tile.included ? "included" : "skipped"} ${hoveredTileId === tile.id ? "highlighted" : ""}`;
                    const tileEvents = {
                      onPointerEnter: () => setHoveredTileId(tile.id),
                      onPointerLeave: () => setHoveredTileId(null),
                    };

                    if (geometryMode === "full") {
                      return (
                        <rect
                          key={tile.id}
                          x={tile.x}
                          y={tile.y}
                          width={tile.width}
                          height={tile.height}
                          className={tileClassName}
                          {...tileEvents}
                        />
                      );
                    }

                    if (geometryMode === "crop") {
                      return (
                        <rect
                          key={tile.id}
                          x={cropGeometry.x + tile.x}
                          y={cropGeometry.y + tile.y}
                          width={Math.min(tile.width, processedWidth - tile.x)}
                          height={Math.min(tile.height, processedHeight - tile.y)}
                          className={tileClassName}
                          {...tileEvents}
                        />
                      );
                    }

                    const radialSpan =
                      annulusGeometry.outerRadius - annulusGeometry.innerRadius;
                    const innerRadius =
                      annulusGeometry.innerRadius +
                      (tile.y / processedHeight) * radialSpan;
                    const outerRadius =
                      annulusGeometry.innerRadius +
                      (Math.min(tile.y + tile.height, processedHeight) /
                        processedHeight) *
                        radialSpan;
                    const startAngle = (tile.x / processedWidth) * Math.PI * 2;
                    const endAngle =
                      (Math.min(tile.x + tile.width, processedWidth) /
                        processedWidth) *
                      Math.PI * 2;

                    return (
                      <path
                        key={tile.id}
                        d={annularSectorPath(
                          annulusGeometry.cx,
                          annulusGeometry.cy,
                          innerRadius,
                          outerRadius,
                          startAngle,
                          endAngle,
                        )}
                        className={tileClassName}
                        {...tileEvents}
                      />
                    );
                  })}
                </g>
              )}

              {step === "region" && regionMode === "dynamic" && (
                <g className="dynamic-ellipse">
                  <ellipse
                    cx={dynamicCenter.x}
                    cy={dynamicCenter.y}
                    rx={dynamicMax / 2}
                    ry={dynamicMax / 2}
                    className="dynamic-max"
                    data-dynamic-control="move"
                  />
                  <ellipse
                    cx={dynamicCenter.x}
                    cy={dynamicCenter.y}
                    rx={dynamicMin / 2}
                    ry={dynamicMin / 2}
                    className="dynamic-min"
                    data-dynamic-control="move"
                  />
                  <circle
                    cx={dynamicCenter.x + dynamicMax / 2}
                    cy={dynamicCenter.y}
                    r={Math.max(sourceWidth, sourceHeight) * 0.0075}
                    className="geometry-handle dynamic-handle"
                    data-dynamic-control="maximum"
                  />
                  <circle
                    cx={dynamicCenter.x + dynamicMin / 2}
                    cy={dynamicCenter.y}
                    r={Math.max(sourceWidth, sourceHeight) * 0.0075}
                    className="geometry-handle dynamic-handle"
                    data-dynamic-control="minimum"
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
                    {previewWidth} × {previewHeight}
                    {" source"}
                  </span>
                </>
              ) : (
                "No image"
              )}
            </div>

            {step === "region" && regionMode === "static" && (
              <div className="drawing-toolbar stage-tools" aria-label="Drawing tools">
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
                        if (
                          (polygonDraftRef.current?.getPoints().length ?? 0) >= 3 &&
                          item.id !== "polygon"
                        )
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

            {samples.length > 0 && (
              <div
                className="sample-switcher stage-samples"
                aria-label="Reference samples"
              >
                {samples.map((sample, index) => (
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
                ))}
              </div>
            )}
          </div>

          {(step === "model" || step === "review") &&
            geometryMode === "annulus" &&
            activeSample && (
              <div className="annulus-strip-panel">
                <div className="annulus-strip-heading">
                  <div>
                    <strong>Unwrapped model input</strong>
                  </div>
                  <span>
                    {processedWidth} × {processedHeight}
                  </span>
                </div>
                <div
                  className="annulus-strip-preview"
                  style={{ aspectRatio: `${processedWidth} / ${processedHeight}` }}
                >
                  <canvas
                    ref={processedPreviewRef}
                    className="processed-preview"
                    aria-label={`Unwrapped annulus preview of ${activeSample.name}`}
                  />
                  {!tilingEnabled && regionMode === "static" && processedMask && (
                    <canvas
                      ref={processedMaskPreviewRef}
                      className="processed-mask-preview"
                      aria-label="Valid region on unwrapped annulus"
                    />
                  )}
                  {tilingEnabled && (
                    <svg
                      viewBox={`0 0 ${processedWidth} ${processedHeight}`}
                      preserveAspectRatio="none"
                      aria-label="Unwrapped annulus tile grid"
                    >
                      {tilingTiles.map((tile) => (
                        <rect
                          key={tile.id}
                          x={tile.x}
                          y={tile.y}
                          width={Math.min(tile.width, processedWidth - tile.x)}
                          height={Math.min(tile.height, processedHeight - tile.y)}
                          className={`tile ${tile.included ? "included" : "skipped"} ${hoveredTileId === tile.id ? "highlighted" : ""}`}
                          onPointerEnter={() => setHoveredTileId(tile.id)}
                          onPointerLeave={() => setHoveredTileId(null)}
                        />
                      ))}
                    </svg>
                  )}
                </div>
              </div>
            )}
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
              {uploadMessage && (
                <FieldMessage
                  message={uploadMessage.message}
                  tone={uploadMessage.tone}
                />
              )}

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
                        onClick={() => handleGeometryModeChange(item.id)}
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
                        invalid={Boolean(geometryIssue)}
                        onChange={(x) =>
                          setCropGeometry((value) => ({ ...value, x }))
                        }
                      />
                      <NumberField
                        label="Y"
                        value={cropGeometry.y}
                        invalid={Boolean(geometryIssue)}
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
                        invalid={Boolean(geometryIssue)}
                        onChange={(width) =>
                          setCropGeometry((value) => ({ ...value, width }))
                        }
                      />
                      <NumberField
                        label="Height"
                        value={cropGeometry.height}
                        min={1}
                        invalid={Boolean(geometryIssue)}
                        onChange={(height) =>
                          setCropGeometry((value) => ({ ...value, height }))
                        }
                      />
                    </div>
                    {geometryIssue && <FieldMessage message={geometryIssue} />}
                  </div>
                </>
              )}

              {geometryMode === "annulus" && (
                <>
                  <div className="field-group">
                    <label className="field-label">Center</label>
                    <div className="field-pair">
                      <NumberField
                        label="X"
                        value={annulusGeometry.cx}
                        invalid={Boolean(geometryIssue)}
                        onChange={(cx) =>
                          setAnnulusGeometry((value) => ({ ...value, cx }))
                        }
                      />
                      <NumberField
                        label="Y"
                        value={annulusGeometry.cy}
                        invalid={Boolean(geometryIssue)}
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
                        invalid={Boolean(geometryIssue)}
                        onChange={(innerRadius) =>
                          setAnnulusGeometry((value) => {
                            const next = { ...value, innerRadius };
                            return stripCustomizedRef.current
                              ? next
                              : { ...next, ...recommendedAnnulusStrip(innerRadius, value.outerRadius) };
                          })
                        }
                      />
                      <NumberField
                        label="Outer"
                        value={annulusGeometry.outerRadius}
                        min={2}
                        invalid={Boolean(geometryIssue)}
                        onChange={(outerRadius) =>
                          setAnnulusGeometry((value) => {
                            const next = { ...value, outerRadius };
                            return stripCustomizedRef.current
                              ? next
                              : { ...next, ...recommendedAnnulusStrip(value.innerRadius, outerRadius) };
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Unwrapped strip size</label>
                    <div className="field-pair">
                      <NumberField
                        label="Width"
                        value={annulusGeometry.stripWidth}
                        min={1}
                        invalid={Boolean(geometryIssue)}
                        onChange={(stripWidth) => {
                          stripCustomizedRef.current = true;
                          setAnnulusGeometry((value) => ({ ...value, stripWidth }));
                        }}
                      />
                      <NumberField
                        label="Height"
                        value={annulusGeometry.stripHeight}
                        min={1}
                        invalid={Boolean(geometryIssue)}
                        onChange={(stripHeight) => {
                          stripCustomizedRef.current = true;
                          setAnnulusGeometry((value) => ({ ...value, stripHeight }));
                        }}
                      />
                    </div>
                    {geometryIssue && <FieldMessage message={geometryIssue} />}
                  </div>
                </>
              )}

              <div className="panel-footer">
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
                  onChange={(event) => {
                    const mode = event.target.value as RegionMode;
                    if (mode === "dynamic" && !dynamicCustomizedRef.current) {
                      const recommendation = recommendedDynamicRange(processedWidth, processedHeight);
                      setDynamicMin(recommendation.minimum);
                      setDynamicMax(recommendation.maximum);
                    }
                    setRegionMode(mode);
                  }}
                >
                  <option value="none">Entire image</option>
                  <option value="static">Static mask — draw shapes</option>
                  <option value="dynamic">
                    Dynamic ellipse — detect per image
                  </option>
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

                  {hasDraftPolygon && (
                    <div className="draft-actions">
                      <span className="draft-count">Polygon in progress</span>
                      <span className="draft-hint">Double-click to finish</span>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="Cancel polygon"
                        onClick={() => polygonDraftRef.current?.clear()}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}

                  {selectedShape && (
                    <div className="selected-shape-note">
                      <MousePointer2 size={15} />
                      Drag the shape to move it, or drag its handles to edit it.
                    </div>
                  )}

                  <div className="mask-preview-block">
                    <div className="section-heading">
                      <div className="section-label">FINAL MASK · LIVE</div>
                      <div className="mask-preview-legend" aria-hidden="true">
                        <span className="mask-swatch valid" /> Included
                        <span className="mask-swatch ignored" /> Excluded
                      </div>
                    </div>
                    <canvas
                      ref={maskPreviewRef}
                      className="mask-preview-canvas"
                      style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
                      aria-label="Live final valid-region mask preview"
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
                      aria-invalid={Boolean(
                        !maskName.trim() ||
                        maskName.includes("/") ||
                        maskName.includes("\\") ||
                        !maskName.toLowerCase().endsWith(".png"),
                      )}
                      onChange={(event) => setMaskName(event.target.value)}
                    />
                    {regionIssue && <FieldMessage message={regionIssue} />}
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
                        model resize. Drag the + to reposition the preview.
                      </span>
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Diameter range</label>
                    <div className="field-pair">
                      <NumberField
                        label="Minimum"
                        value={dynamicMin}
                        min={1}
                        invalid={Boolean(regionIssue)}
                        onChange={(value) => {
                          dynamicCustomizedRef.current = true;
                          setDynamicMin(value);
                        }}
                      />
                      <NumberField
                        label="Maximum"
                        value={dynamicMax}
                        min={2}
                        invalid={Boolean(regionIssue)}
                        onChange={(value) => {
                          dynamicCustomizedRef.current = true;
                          setDynamicMax(value);
                        }}
                      />
                    </div>
                    {regionIssue && <FieldMessage message={regionIssue} />}
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
                <label className="field-label">Model input size</label>
                <div className="field-pair">
                  <NumberField
                    label="Width"
                    value={inputWidth}
                    min={1}
                    invalid={Boolean(modelInputIssue)}
                    onChange={(value) => {
                      modelInputCustomizedRef.current = true;
                      setInputWidth(value);
                    }}
                  />
                  <NumberField
                    label="Height"
                    value={inputHeight}
                    min={1}
                    invalid={Boolean(modelInputIssue)}
                    onChange={(value) => {
                      modelInputCustomizedRef.current = true;
                      setInputHeight(value);
                    }}
                  />
                </div>
                {modelInputIssue && <FieldMessage message={modelInputIssue} />}
                <div className="field-hint">
                  {tilingEnabled
                    ? "Every native tile is resized to this size."
                    : "The complete processed image is resized to this size."}
                </div>
              </div>

              <ToggleRow
                checked={tilingEnabled}
                onChange={handleTilingChange}
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
                    <label className="field-label">Tile size</label>
                    <div className="field-pair">
                      <NumberField
                        label="Width"
                        value={tileWidth}
                        min={1}
                        invalid={Boolean(tileIssue)}
                        onChange={(value) => {
                          tilingCustomizedRef.current = true;
                          setTileWidth(value);
                        }}
                      />
                      <NumberField
                        label="Height"
                        value={tileHeight}
                        min={1}
                        invalid={Boolean(tileIssue)}
                        onChange={(value) => {
                          tilingCustomizedRef.current = true;
                          setTileHeight(value);
                        }}
                      />
                    </div>
                    {tileIssue && <FieldMessage message={tileIssue} />}
                    <div className="field-hint">
                      Pixels in the {processedWidth} × {processedHeight} processed image.
                    </div>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Stride</label>
                    <div className="field-pair">
                      <NumberField
                        label="Width"
                        value={strideWidth}
                        min={1}
                        invalid={Boolean(strideIssue)}
                        onChange={(value) => {
                          tilingCustomizedRef.current = true;
                          setStrideWidth(value);
                        }}
                      />
                      <NumberField
                        label="Height"
                        value={strideHeight}
                        min={1}
                        invalid={Boolean(strideIssue)}
                        onChange={(value) => {
                          tilingCustomizedRef.current = true;
                          setStrideHeight(value);
                        }}
                      />
                    </div>
                    {strideIssue && <FieldMessage message={strideIssue} />}
                    <div className="field-hint">
                      Equal to tile size gives no overlap; smaller values create overlapping tiles.
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
                  {coverageIssue && <FieldMessage message={coverageIssue} />}
                </>
              )}

              <ToggleRow
                checked={artifactEnabled}
                onChange={setArtifactEnabled}
                icon={<Scaling size={16} />}
                title="Limit output image size"
                detail="Preserves aspect ratio"
              />
              {artifactEnabled && (
                <div className="field-group">
                  <label className="field-label">Output image maximum size</label>
                  <div className="field-pair">
                    <NumberField
                      label="Width"
                      value={artifactWidth}
                      min={1}
                      invalid={Boolean(artifactIssue)}
                      onChange={(value) => {
                        artifactCustomizedRef.current = true;
                        setArtifactWidth(value);
                      }}
                    />
                    <NumberField
                      label="Height"
                      value={artifactHeight}
                      min={1}
                      invalid={Boolean(artifactIssue)}
                      onChange={(value) => {
                        artifactCustomizedRef.current = true;
                        setArtifactHeight(value);
                      }}
                    />
                  </div>
                  {artifactIssue && <FieldMessage message={artifactIssue} />}
                </div>
              )}

              <div className="panel-footer">
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
              {reviewMessage && (
                <div className="review-context-message">
                  <FieldMessage
                    message={reviewMessage.message}
                    tone={reviewMessage.tone}
                  />
                </div>
              )}

              <div className="field-group">
                <label className="field-label" htmlFor="profile-name">
                  Profile name
                </label>
                <input
                  id="profile-name"
                  type="text"
                  value={profileName}
                  aria-invalid={Boolean(profileNameIssue)}
                  onChange={(event) => setProfileName(event.target.value)}
                />
                {profileNameIssue ? (
                  <FieldMessage message={profileNameIssue} />
                ) : profileName.trim() !== slugify(profileName) ? (
                  <FieldMessage
                    tone="warning"
                    message={`Filename will be normalized to ${slugify(profileName)}.json.`}
                  />
                ) : null}
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
                  <span className="derived-badge">Read only</span>
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
                    <Download size={17} />
                    Download
                  </>
                )}
              </button>
              {exportMessage && (
                <FieldMessage
                  message={exportMessage.message}
                  tone={exportMessage.tone}
                />
              )}
              {validation.some((check) => !check.ok) && (
                <FieldMessage
                  message="Download is unavailable. Please review the validation errors above."
                />
              )}

            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function FieldMessage({
  message,
  tone = "error",
}: {
  message: string;
  tone?: "error" | "warning";
}) {
  return (
    <div
      className={`field-message ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={13} />
      <span>{message}</span>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  invalid = false,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  invalid?: boolean;
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
        step={1}
        aria-invalid={invalid}
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
