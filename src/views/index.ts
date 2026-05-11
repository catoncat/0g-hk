// Barrel re-export for src/index.ts to swap from ./pages.js to ./views/index.js
// with a single import line. Each view is a thin function that returns a
// Response built from JSX + the shared html() helper.
export { editorPage } from "./EditorPage.js";
export { resultPage } from "./ResultPage.js";
export { notePage } from "./NotePage.js";
export { interstitialPage } from "./InterstitialPage.js";
export { editNotePage } from "./EditNotePage.js";
export { notFoundPage } from "./NotFoundPage.js";
