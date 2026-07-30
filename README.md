# Profile Studio

Profile Studio is a standalone, local-first editor for anomaly-detection
training profiles. It turns image geometry, valid regions, tiling, and artifact
settings into a detector-compatible JSON profile and optional binary mask.

## Features

- Load several aligned reference images and switch between them while editing.
- Configure full-image, crop, or annulus preprocessing.
- Draw include/exclude polygons and ellipses for a static valid-region mask.
- Configure dynamic ellipse localization.
- Preview input sizing and ROI-aware tiling with the 30% inclusion threshold.
- Import an existing profile JSON.
- Validate settings and export a portable ZIP with the profile, mask, preview,
  editable project data, and placement instructions.
- Keep drafts in browser storage; uploaded images remain local to the browser.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

## Production build

```bash
npm run build
npm run start
```

## Export layout

```text
<profile-name>-profile.zip
├── profiles/<profile-name>.json
├── dataset/valid_regions/<mask-name>.png
├── previews/valid-region-overlay.png
├── builder-project.json
├── manifest.json
└── README.txt
```

The mask is an 8-bit source-resolution PNG containing only black and white
pixels. Static polygon and ellipse drawings both export as a mask valid region.
The profile's `ellipse` valid-region type remains reserved for per-image dynamic
ellipse detection.
