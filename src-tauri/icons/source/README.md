# Icon source

`icon.html` is the master artwork: a dark squircle holding a 2x2 pane grid with
one active pane, standing in for the multi-terminal workspace. It is HTML so it
can be edited without a design tool.

To regenerate every platform icon after changing it, render the HTML to a
1024x1024 PNG and let the Tauri CLI expand it:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --force-device-scale-factor=1 \
  --window-size=1024,1024 \
  --screenshot=src-tauri/icons/source/icon.png \
  "file://$PWD/src-tauri/icons/source/icon.html"

npx tauri icon src-tauri/icons/source/icon.png
```

`tauri icon` also emits iOS and Android assets. GrokSpace is a desktop app, so
delete `src-tauri/icons/{android,ios}` and the `Square*.png` / `StoreLogo.png`
Windows Store variants afterwards.

The 100px inset and 185px corner radius follow the macOS icon grid, which
expects artwork to sit on a squircle inside a padded 1024px canvas.
