# shotsweep

Capture every screen of your web app with one command, then give the batch to any AI for review.

Apps built with AI coding tools often ship before anyone has looked at every screen. shotsweep visits your running app, finds the pages, closes the onboarding popups, logs in for you, and bundles labeled, compressed screenshots with a ready-made review prompt. Capturing uses plain code, so it costs **zero AI credits**. You spend tokens once, when you upload the finished batch to ChatGPT, Claude, Gemini, or a human reviewer.

<!-- Add a demo GIF here: ![shotsweep demo](docs/demo.gif) -->

## Quick start

Start your app (for example `npm run dev`), then in another terminal:

```bash
npx shotsweep http://localhost:3000
```

The first run downloads the Chromium browser used for screenshots (about 150 MB, one time). You get:

```
shotsweep-export/
├── manifest.md              routes, viewports and a review prompt to paste into the AI
├── 01-home-desktop.jpg
├── 01-home-mobile.jpg
├── 02-dashboard-desktop.jpg
└── ...
shotsweep-export.zip            the same, zipped
```

Requires Node.js 18 or newer.

## What it does

- **Finds your pages by itself.** It reads your source code (`-p ./my-app`), `sitemap.xml`, links on the page, `#hash` routes, and menus that switch screens without changing the URL.
- **Gets past popups.** It clicks through onboarding tours and modals, however many steps they have, then captures the real page. Add `--capture-popups` to photograph each step too.
- **Works behind a login.** Log in by hand once (`--login`), or let it sign in with a test account from your config. Capture the logged-out login page with `--logged-out "/login"`.
- **Makes uploads cheap and readable.** Images are resized, converted to JPEG, and very tall pages are split into parts so text stays legible when an AI shrinks the image.
- **Stays safe.** It never clicks Log out, and it skips buttons that look like actions (Generate, Save, Export, Delete, Pay, Upload ...).
- **Runs locally.** Nothing is sent anywhere. Files leave your machine only when you upload them.

## Common commands

```bash
npx shotsweep http://localhost:3000                  # discover and capture everything
npx shotsweep http://localhost:3000 -p ./my-app      # also read routes from your source code
npx shotsweep http://localhost:3000 -v desktop       # desktop only (half the images)
npx shotsweep http://localhost:3000 -r /,/pricing    # only these routes
npx shotsweep http://localhost:3000 -x "/admin/*"    # skip routes
npx shotsweep --init                                 # create shotsweep.config.json
npx shotsweep                                        # run with settings from shotsweep.config.json
```

## Login

**Log in by hand once** (works with Google login and 2FA):

```bash
npx shotsweep http://localhost:3000 --login
```

A browser window opens. Log in, then press Enter in the terminal. The session is saved to `.shotsweep/auth.json` and reused automatically.

**Or sign in automatically with a test account**, in `shotsweep.config.json`:

```json
{
  "login": {
    "url": "/login",
    "email": "${SHOTSWEEP_EMAIL}",
    "password": "${SHOTSWEEP_PASSWORD}"
  }
}
```

Set the variables first. Windows cmd: `set SHOTSWEEP_EMAIL=test@example.com`. PowerShell: `$env:SHOTSWEEP_EMAIL="test@example.com"`. macOS/Linux: `export SHOTSWEEP_EMAIL=test@example.com`. For unusual forms you can give your own `steps` (fill, click, press, waitFor, goto, wait).

Use a test account on a dev site. `.shotsweep/auth.json` holds live session tokens, so never commit or share it.

## Config file

Keep settings per site in `shotsweep.config.json` (see `examples/`). Priority: command-line flag, then config file, then default.

```json
{
  "url": "http://localhost:3000",
  "project": "./my-app",
  "viewports": ["desktop", "mobile"],
  "popupButtons": ["Launch Studio"],
  "skipLabels": ["Need help? Chat with us"],
  "exclude": ["/admin/*"],
  "loggedOutRoutes": ["/login"],
  "capturePopups": false,
  "maxWidth": 1280,
  "imageFormat": "jpeg",
  "quality": 80
}
```

Use `-c other.json` to pick a different config file.

## All options

| Option | Meaning | Default |
|---|---|---|
| `-c, --config <file>` | config file | `shotsweep.config.json` |
| `--init` | create a config template and exit | |
| `-o, --out <dir>` | output folder | `shotsweep-export` |
| `-v, --viewports <list>` | `desktop`, `tablet`, `mobile` | `desktop,mobile` |
| `-m, --max-pages <n>` | max pages to discover | `30` |
| `-r, --routes <list>` | skip discovery, use these routes | |
| `-p, --project <dir>` | read routes from your source folder | |
| `-x, --exclude <list>` | route patterns to skip | |
| `-s, --skip-labels <list>` | buttons never to click (exact label) | |
| `--popup-buttons <list>` | extra popup button labels to click | |
| `--capture-popups` | also screenshot each popup step | off |
| `--login` | log in by hand and save the session | |
| `--auth <file>` | saved login file | `.shotsweep/auth.json` |
| `--logged-out <list>` | capture these routes without the saved login | |
| `--no-click` | do not click menus to find screens | |
| `--no-session` | do not reuse browser storage between pages | |
| `-d, --delay <ms>` | extra wait after load | `500` |
| `--no-optimize` | keep full-size PNGs | |
| `--max-width <px>` | shrink wider images | `1280` |
| `--slice-height <px>` | split taller pages into parts (0 = never) | `1400` |
| `--format <fmt>` | `jpeg`, `webp`, `png` | `jpeg` |
| `--quality <n>` | JPEG/WebP quality | `80` |
| `--keep-originals` | keep PNGs in `<out>-originals` | |
| `--no-zip` | do not create the ZIP | |
| `-V, --version` | print the version | |

## Troubleshooting

- **"Cannot reach ..."**: your dev server is not running, or the port is different.
- **Only the home page is found**: pass your source folder with `-p`, or list routes with `-r /,/about,/pricing`.
- **A popup is still on screen**: the output lists the button names it saw. Add the right one with `--popup-buttons "Button text"`.
- **Blank or half-loaded screenshots**: add wait time with `-d 1500`.
- **Screens behind a login look like the login page**: run `--login` again, the session may have expired.

## Limits

- State kept only in `sessionStorage` is not saved with the login.
- Modals that add only a few words to a page count as the same screen as the page.
- Sites that block automated browsers (strict bot protection) may not load.

## Try it without a project

`examples/landing-test/` is a small demo site with a landing page, a login (any email and password works) and a dashboard.

```bash
cd examples/landing-test && npx serve -l 3000 .          # terminal 1
npx shotsweep -c examples/shotsweep.landing-test.json          # terminal 2
```

## Development

```bash
npm install
npm run dev -- http://localhost:3000   # run from source
npm run build                          # compile to dist/
```

## License

MIT
