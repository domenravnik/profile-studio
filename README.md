# Profile Studio

Profile Studio is a local editor for anomaly-detector training profiles. Use a
reference image to configure preprocessing, valid regions, tiling, and output
settings, then download the files needed by the detector.

## Features

- Load several aligned reference images and switch between them while editing.
- Configure full-image, crop, or annulus preprocessing.
- Draw include/exclude polygons and ellipses for a static valid-region mask.
- Configure dynamic ellipse localization.
- Preview native post-geometry tiling and exact static-ROI coverage with the 30% inclusion threshold.
- Import an existing profile JSON or a complete Studio project ZIP.
- Validate settings and download a ZIP containing the detector profile, an
  optional static mask, editable Studio settings, and reference images.
- Keep drafts in browser storage; uploaded images remain local to the browser.

Profile JSON uses named geometry objects: sizes contain `width` and `height`, positions contain `x` and `y`,
annulus radii contain `inner` and `outer`, and ranges contain `min` and `max`.

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

## Exported files

Every export contains the detector profile and the Studio project data:

```text
<profile-name>.zip
├── profiles/<profile-name>.json
└── studio/
    ├── project.json
    └── reference_images/
        └── <original-image-name>
```

Reference images keep their imported filenames. When filenames collide, the
later files receive numeric suffixes such as `_2`. Importing the ZIP restores
the images, active image, editable valid-region shapes, and Studio state.

Profiles that use a static valid region also contain its mask:

```text
dataset/valid_regions/<mask-name>.png
```

Copy the profile JSON into the detector's `PROFILES_ROOT`. For a static valid
region, also copy the mask into the target dataset's `valid_regions` directory.

The optional mask is an 8-bit, source-resolution PNG containing only black and
white pixels. White pixels are the usable part of the configured geometry and
static shapes; pixels outside a crop or annulus are black. Dynamic ellipse
regions are detected for each image and therefore do not export a mask.

When tiling is enabled, `tile_size` and `stride` are measured in the native
processed image (full image, crop, or unwrapped annulus). Every included tile is
then resized independently to `model_input_size` for PatchCore.
