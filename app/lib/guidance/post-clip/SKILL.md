---
name: post-clip
description: Making a short clip of the app for its post on CloudChef — real screenshots of the live site taken with a headless browser in the workspace, a timeline with zoom, captions, tap marks and spoken lines, shown in the chat for the person to approve. Read when the person asks for a clip or video of their app, or before offering one after a public project is published.
---

A public project that has been published has a post on its author's CloudChef page (`cloudchef.build/<owner>/<slug>`), showing a screenshot of its live site. The post can also carry a short clip: a few real pictures of the app being used, shown one after another with a slow zoom, a caption, a tap mark where something was pressed, and an optional spoken line. It is not a video file. CloudChef's own player plays it from a timeline and the pictures, so nothing of the project runs on CloudChef.

Make one when the person asks. After publishing a public project you may offer once, in a sentence ("Want a short clip of it for your post?"); never make or post one unasked. A clip goes on the post only when the person presses Approve in the chat, so `cloudchef reel` never posts by itself.

## Taking the pictures

Use agent-browser in the workspace, installed outside the project so nothing is added to it:

```sh
mkdir -p /tmp/clip-kit /tmp/clip && cd /tmp/clip-kit
npm init -y >/dev/null && npm install --no-audit --no-fund agent-browser@0.39.1
npx agent-browser install --with-deps
```

Then drive the live site (its public address, not a dev server) the way a visitor would, saving a picture after each moment worth showing. Keep the pictures out of the project, in `/tmp/clip`:

```sh
cd /tmp/clip-kit
export AGENT_BROWSER_SCREENSHOT_FORMAT=jpeg AGENT_BROWSER_SCREENSHOT_QUALITY=80
npx agent-browser set viewport 1280 800
npx agent-browser open https://recipes.example.workers.dev
npx agent-browser wait --load networkidle
npx agent-browser screenshot /tmp/clip/1-home.jpeg
npx agent-browser snapshot -i            # interactive elements with refs such as @e3
npx agent-browser get box @e3            # where the tap mark goes: x + width / 2, over the viewport's width
npx agent-browser click @e3
npx agent-browser find label Name fill 'Lemon cake'
npx agent-browser screenshot /tmp/clip/2-form.jpeg
npx agent-browser close
```

- Four to eight pictures tell it: the first screen, then each step of one thing a person does with the app (a click, a filled form, a timer running, the result).
- Use one viewport for every picture: 1280x800 for a desktop app, or 390x844 for a phone-first one.
- Use made-up example content. Never sign in, and never show anyone's real data, an email address or a key.
- Each picture is a JPEG, WebP or PNG of at most 512 KB; JPEG at quality 80, as above, stays well under it.
- Note where each press happened, as fractions of the picture (x from the left, y from the top), for its tap mark.

## The script: `reel.json`

Beside the pictures, in the same folder:

```json
{
  "voice": "athena",
  "steps": [
    {
      "still": "1-home.jpeg",
      "seconds": 2.5,
      "caption": "Your recipes, all in one place",
      "say": "Here are all your recipes."
    },
    {
      "still": "1-home.jpeg",
      "seconds": 2,
      "pan": { "from": { "x": 0.5, "y": 0.5, "zoom": 1 }, "to": { "x": 0.82, "y": 0.12, "zoom": 2 } },
      "tap": { "x": 0.82, "y": 0.12, "at": 1.4 },
      "caption": "Add one in a tap"
    },
    { "still": "2-form.jpeg", "seconds": 3, "caption": "Type it in and save" }
  ]
}
```

- `steps`: 1 to 12, at most 45 seconds in all. Each names a picture beside the script (`still`) and how long it shows (`seconds`, 0.8 to 8).
- `pan` (optional): the frame moves from `from` to `to` over the step. `x`, `y` are the point at the frame's centre, as fractions of the picture; `zoom` is 1 (the whole picture) to 3. Leave it out to show the whole picture still. A slow move toward what matters next reads best; avoid moving on every step.
- `tap` (optional): a ring where something was pressed, at `x`, `y` (fractions of the picture), `at` seconds into the step.
- `caption` (optional): up to 120 characters of plain words, shown over the picture. Say what the person can do, in everyday words.
- `say` (optional): a line spoken over the step, up to 240 characters, spoken by Workers AI in the person's own Cloudflare account. The step is lengthened to fit it. A line of about 12 words takes 4 seconds. With the sound off, a spoken line with no caption is shown as one.
- `voice` (optional): `athena` (the default), `apollo`, `asteria`, `aurora`, `cora`, `helena`, `hermes`, `luna`, `orion`, `thalia` or `zeus`.

## Showing it to the person

```sh
cloudchef reel /tmp/clip
```

It checks the pictures and the script, speaks the lines, and shows the clip playing in the chat with Approve and Not now; its output says what is wrong when something is. Tell the person it is there, in a sentence; they decide in the chat. Approving puts it on their post, replacing any clip before it; they can take it off later with Remove clip on the post's menu. Making another clip is fine when they ask for changes.
