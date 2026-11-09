# Rimshot

A dark, liquid-glass mini player for Windows. Album art is printed on CDs that sit on the rim of a huge wheel. You only see the bottom of the wheel. When you skip, the current disc rolls off to the right and up along the rim, and the next one rolls in from the left.

## Run

```bash
npm install
npm start
```

No login is needed. The app reads Windows' media controls (the same source as the volume flyout), so it works with the Spotify desktop app, including free accounts. It also works with browsers and other players. When more than one app is playing, Spotify wins.

## Controls

| Action | How |
| --- | --- |
| Play / pause | Play button, click the centre disc, or `Space` |
| Next / previous | Buttons, `←` / `→`, or click the disc on the left / right |
| Spin the wheel | Drag sideways and flick. Momentum decides how many tracks to skip (up to 3) |
| Seek | Click or drag the progress bar. Hover shows the time. `←` / `→` while it's focused moves 5 s |
| Settings | Sliders button, top right |
| Window size | Settings → Compact (480×420), Wide (880×440) or Full screen |
| Full screen | `F11` or Settings. `Esc` leaves. The title bar and cursor fade out when the mouse rests |
| Keep on top | Settings or the green dot. Stays above other windows, including other always-on-top ones |
| Spin discs / Ambient glow | Settings toggles |
| Demo mode | `D` (generated covers, no player needed) |

Only the playing disc spins. It spins up when it rolls in and winds down when you pause. All discs turn together while the wheel rolls.

The app icon is drawn by `build/make-icon.js`. To regenerate `build/icon.ico` and `build/icon.png`, run `npm run icon`.

Settings and the window position are saved in `%APPDATA%\Rimshot\settings.json`.

Previous behaves like Spotify: past 3 seconds it restarts the song. Dragging the wheel back always goes to the previous disc.

## How it's built

- `main.js` is the Electron window. It also starts `native/media-bridge.ps1`, a long-running PowerShell process that talks to `GlobalSystemMediaTransportControlsSessionManager` and streams JSON lines (state, album art). It takes commands on stdin.
- `src/discs.js` draws the CDs on a canvas. The print rotates with the disc, while the iridescent sheen and highlight stay fixed to the light.
- `src/spring.js` has Apple-style springs (damping + response), momentum projection and rubber-banding, following *Designing Fluid Interfaces*.
- `src/glass.js` is the liquid glass. Its refraction shader is adapted from [liquid-glass-js](https://github.com/dashersw/liquid-glass-js) (MIT, © dashersw). The original samples one static page snapshot; here every glass shape samples the live CD canvas every frame, so the rolling discs bend through the panel edges.

Windows doesn't expose the upcoming queue. A blank disc rolls in right away when you skip, and its art fades in once the player reports the new track.
