# Depth Clock

Depth Clock is a GNOME Shell extension that brings an iOS-style 3D depth effect clock to your Linux desktop wallpaper. By running an on-device AI segmentation model, the extension separates foreground subjects from your desktop wallpaper and renders a customizable clock tucked naturally behind foreground elements.

## Previews

| | |
| :---: | :---: |
| ![Depth Clock Preview 1](assets/screenshots/screenshot-1.png) | ![Depth Clock Preview 2](assets/screenshots/screenshot-2.png) |
| ![Depth Clock Preview 3](assets/screenshots/screenshot-3.png) | ![Depth Clock Preview 4](assets/screenshots/screenshot-4.png) |

## Suitable Wallpapers

For the best 3D depth effect, use wallpapers with:
- Well-defined foreground subjects (people, anime or gaming characters, pets, statues, architecture).
- Good contrast between foreground subjects and the background sky or scenery.
- Sufficient space for the clock digits to sit behind foreground elements without obstructing legibility.

A curated collection of wallpapers tested and optimized for Depth Clock is available at:
- [depth-clock-wallpapers](https://github.com/suraj-yadav0/depth-clock-wallpapers)

## Clock Interaction Modes

Depth Clock includes seven distinct interaction modes:

| Mode | Identifier | Description |
| :--- | :--- | :--- |
| **3D Depth Effect** | `depth` | Classic spatial depth. Segments foreground subjects and places digits tucked naturally behind them. |
| **Silhouette Flow** | `contour-flow` | Digits perch along the elevation curve of the subject silhouette, matching local slopes and flowing across contours. |
| **Contour-Adaptive** | `contour-stretch` | Digits dynamically scale and stretch downwards to meet the subject contour, with options for vertical stretch or proportional fit. |
| **Silhouette Inversion** | `silhouette-invert` | Digits span across subject boundaries. Intersecting regions inside the foreground silhouette invert dynamically (high-contrast, stencil outline, or vivid accent). |
| **Interactive Parallax** | `depth-parallax` | Mouse motion triggers multi-plane 3D spatial displacement between the background wallpaper, clock layer, and foreground subject. |
| **Backlit Rim Glow** | `rim-glow` | Digits sit behind the subject, casting an illuminated neon edge aura along the silhouette perimeter where digits intersect foreground contours. |
| **Standard Flat Clock** | `flat` | Clean 2D clock display without subject occlusion or geometry deformation. |

## Mode Customization Options

- **Dual-Tone Hour/Minute Accents**: Tint hour digits with the dominant wallpaper accent and minute digits with a clean complementary tone.
- **Contour Style**: Choose between flexible vertical stretch (`stretch`) or proportional scale (`fit`).
- **Contour & Flow Clearance**: Adjust the vertical gap in pixels between the clock baseline and subject silhouette.
- **Invert Style**: Select how digits render over the silhouette (`contrast` for dark/light inversion, `outline` for stencil contour lines, or `accent` for color-shift pop).
- **Parallax Intensity**: Configure spatial displacement sensitivity (1 to 50 pixels).
- **Glow Radius & Intensity**: Fine-tune rim aura thickness and luminosity.
- **Custom Rim Glow Color**: Select an independent aura color or link directly to the primary clock color.

## Performance and Resource Efficiency

Depth Clock is engineered to run with minimal CPU and GPU overhead:

- **Zero Idle Redraws**: Time evaluation is minute-aligned. When the minute and date have not changed, time updates return immediately without scene graph renegotiation or Cairo redraws.
- **Scene Graph Actor Pruning**: Full-screen DrawingAreas (`_cutoutArea`, `_glowArea`, `_overlayArea`) are hidden (`visible = false`) when not required by the active mode. Hidden actors are skipped completely by Clutter, eliminating redundant transparent GPU compositing passes on every desktop frame.
- **Native Memory Lifecycle Management**: Backing Cairo image surfaces are explicitly finalized (`cairo_surface_finish`) upon wallpaper transitions, preventing native unmanaged RAM retention.
- **Direct 1024x1024 Mask Analysis**: Contour extraction and occlusion metrics sample directly from the 1024x1024 neural network tensor in NumPy, avoiding heavy 4K median filtering and multi-megabyte array allocations.
- **Thread-Bounded Inference**: ONNX Runtime CPU execution is constrained to 4 threads with single inter-op concurrency, preventing UI stutter or desktop thread starvation during background segmentation.
- **Event-Driven Parallax**: Motion tracking extracts coordinates directly from Clutter stage events, skipping redundant IPC queries and suppressing transform passes when integer pixel coordinates have not changed.

## Features

- **Automatic Foreground Occlusion**: Segments people, pets, architecture, and objects using on-device neural networks.
- **Adaptive Wallpaper Color**:
  - Automatically samples wallpaper luminance in the clock region (upper 12% to 50%).
  - Extracts dominant, vibrant color accents in HLS color space and calculates contrast-optimized clock text colors.
  - Automatically adapts between high-luminance tints on dark backgrounds and deep, readable tones on light backgrounds.
  - Live updates when switching wallpapers, GNOME dark/light modes, or display layouts.
  - Preference switch with live color badge and manual override via native GTK4 color selector dialog.
- **In-Preferences AI Setup**: Check AI model readiness and download/reinstall model weights directly within GNOME extension settings.
- **Direct Desktop Controls**: Click and drag the clock anywhere on your desktop to reposition. Scroll over the clock to resize dynamically.
- **Customization**:
  - Native Font & Color Selectors: Choose installed system fonts (weights, styles) and custom colors using GTK4 modal dialogs.
  - 12-hour or 24-hour time format.
  - Optional date indicator.
  - Stacked digits layout (hours on top, minutes below) or classic horizontal layout.
  - Automatic legibility safeguard (disables occlusion if the subject covers more than 85% of the digits).
- **100% Local and Private**: All segmentation runs locally using CPU-optimized ONNX Runtime. No images ever leave your computer.
- **Multi-Monitor and Orientation Support**: Handles primary display positioning, monitor aspect-fill scaling, spanned wallpaper geometry, and automatic re-segmentation on display rotation.
- **Modern GNOME Support**: Compatible with GNOME Shell 45, 46, 47, 48, 49, and 50+.

## How It Works

1. The extension listens for wallpaper changes from `org.gnome.desktop.background`.
2. When the wallpaper changes, a background Python worker runs the RMBG-1.4 model to generate an alpha cutout mask of foreground subjects.
3. The generated mask is cached under `~/.cache/depth-clock/` keyed by wallpaper path, timestamp, and resolution.
4. When Adaptive Wallpaper Color is enabled, the extension analyzes the luminance of the clock area and extracts dominant accent hues to adjust text color automatically.
5. The extension inserts a layered container directly into GNOME Shell's background layer:
   - Bottom: System wallpaper
   - Middle: Depth Clock widget
   - Top: Cairo drawing surface rendering the foreground cutout mask

## Compatibility

Depth Clock requires GNOME Shell 45 or newer (which uses ES Modules). It is not compatible with GNOME 44 or older, nor does it support other desktop environments (KDE, XFCE, Cinnamon, or tiling window managers).

### Supported Distributions

- Ubuntu 24.04 LTS or newer
- Fedora 39 or newer
- Debian 13 (Trixie) or newer
- Arch Linux / Manjaro (running GNOME 45+)
- openSUSE Tumbleweed

### Incompatible Distributions

- Ubuntu 22.04 LTS and older (ships with GNOME 42 or earlier)
- Debian 12 (Bookworm) and older (ships with GNOME 43 or earlier)
- RHEL 9 / Rocky Linux 9 / AlmaLinux 9 (ships with GNOME 40)
- Fedora 38 and older

## Requirements

- GNOME Shell 45 or newer
- Python 3.10+ with `venv` support
- x86_64 CPU with AVX support (required by ONNX Runtime)
- `curl`
- `glib-compile-schemas` (part of `libglib2.0-bin` on Debian/Ubuntu, `glib2` on Fedora/Arch)

### Installing System Prerequisites

On Ubuntu / Debian:
```bash
sudo apt update
sudo apt install python3 python3-venv curl libglib2.0-bin
```

On Fedora:
```bash
sudo dnf install python3 curl glib2
```

On Arch Linux:
```bash
sudo pacman -S python curl glib2
```

## Installation

### Single-Click Install (Extension Manager / ZIP)

1. Download `depth-clock@suraj-yadav0.github.io.shell-extension.zip` from the latest [GitHub Release](https://github.com/suraj-yadav0/depth-clock/releases/latest).
2. Open **Extension Manager** (or GNOME Extensions), click **Install from ZIP**, and select the downloaded archive.
   Alternatively, install via terminal:
   ```bash
   gnome-extensions install --force depth-clock@suraj-yadav0.github.io.shell-extension.zip
   gnome-extensions enable depth-clock@suraj-yadav0.github.io
   ```
3. Restart GNOME Shell (log out and back in on Wayland, or press `Alt+F2`, type `r`, and press `Enter` on X11).
4. Open extension preferences (`gnome-extensions prefs depth-clock@suraj-yadav0.github.io`) and click **Download & Set Up** under **AI Model Status** to initialize the AI backend.

### One-Line Automated Install

Run the installer directly from your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/suraj-yadav0/depth-clock/main/install.sh | bash
```

### Manual Installation

Clone the repository and execute the installer:

```bash
git clone https://github.com/suraj-yadav0/depth-clock.git
cd depth-clock
./install.sh
```

The installer will:
1. Create an isolated Python virtual environment at `~/.local/share/depth-clock/venv`.
2. Install required Python packages (`onnxruntime`, `numpy`, `pillow`).
3. Download the RMBG-1.4 ONNX model (~176 MB) from Hugging Face into `~/.local/share/depth-clock/models/`.
4. Install the Antonio Bold font into `~/.local/share/fonts/`.
5. Deploy the GNOME extension to `~/.local/share/gnome-shell/extensions/depth-clock@suraj-yadav0.github.io/`.
6. Compile the GSettings schemas and enable the extension.

## Activating the Extension

After running the installer, reload GNOME Shell:

- On Wayland: Log out and log back in.
- On X11: Press `Alt+F2`, type `r`, and press `Enter`.

Enable the extension if not enabled automatically:

```bash
gnome-extensions enable depth-clock@suraj-yadav0.github.io
```

Open extension settings:

```bash
gnome-extensions prefs depth-clock@suraj-yadav0.github.io
```

## Settings Reference

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `clock-mode` | `s` | `'depth'` | Active mode: `'depth'`, `'contour-flow'`, `'contour-stretch'`, `'silhouette-invert'`, `'depth-parallax'`, `'rim-glow'`, `'flat'`. |
| `enable-depth` | `b` | `true` | Master switch for foreground segmentation. |
| `clock-x` | `d` | `0.5` | Normalized horizontal position (0.0 to 1.0). |
| `clock-y` | `d` | `0.3` | Normalized vertical position (0.0 to 1.0). |
| `clock-scale` | `d` | `1.0` | Clock scaling factor (0.3 to 3.5). |
| `clock-font` | `s` | `'Antonio Bold 250'` | Clock typography font family and weight. |
| `clock-color` | `s` | `'#ffffff'` | Clock text color in hex format. |
| `clock-opacity` | `d` | `1.0` | Opacity from 0.1 to 1.0. |
| `time-format-24h` | `b` | `true` | 24-hour vs 12-hour format. |
| `stack-digits` | `b` | `false` | Stack hours above minutes. |
| `show-date` | `b` | `true` | Show date indicator below clock. |
| `auto-color` | `b` | `false` | Adaptive wallpaper palette extraction. |
| `auto-adapt` | `b` | `true` | Safeguard disabling depth on heavy occlusion (>85%). |
| `dual-tone` | `b` | `true` | Dual-tone hour/minute styling in contour modes. |
| `contour-clearance` | `i` | `12` | Vertical baseline padding for contour stretch. |
| `contour-style` | `s` | `'stretch'` | Contour mode scaling: `'stretch'` or `'fit'`. |
| `flow-clearance` | `i` | `8` | Baseline clearance for silhouette flow. |
| `invert-style` | `s` | `'contrast'` | Inversion style: `'contrast'`, `'outline'`, `'accent'`. |
| `parallax-intensity`| `i` | `18` | Spatial shift intensity in pixels (1 to 50). |
| `glow-radius` | `i` | `16` | Rim glow aura stroke radius (4 to 48). |
| `glow-intensity` | `d` | `0.85` | Rim glow opacity and brightness (0.1 to 1.0). |
| `glow-color` | `s` | `'#ffffff'` | Rim glow stroke color in hex format. |

## Repository Structure

```
depth-clock/
├── assets/
│   └── screenshots/          # Desktop preview screenshots
├── backend/
│   ├── requirements.txt      # Python dependencies (numpy, pillow, onnxruntime)
│   ├── segment.py            # Wallpaper segmentation worker
│   └── test_segment.py       # Standalone test script for image segmentation
├── extension/
│   ├── backend/              # Bundled segmentation worker
│   ├── extension.js          # Core GNOME Shell extension logic and actors
│   ├── metadata.json         # Extension metadata and supported GNOME versions
│   ├── prefs.js              # Preferences window (libadwaita)
│   ├── stylesheet.css        # Clock widget styles
│   └── schemas/
│       └── org.gnome.shell.extensions.depth-clock.gschema.xml
├── fonts/
│   └── Antonio-Bold.ttf      # Default recommended clock font
├── install.sh                # Automated setup and installer
├── uninstall.sh              # Clean removal script
├── .gitignore
├── LICENSE                   # GNU General Public License v3.0
└── README.md
```

## Uninstallation

To remove the extension, backend files, virtual environment, and cached cutouts:

```bash
./uninstall.sh
```

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
