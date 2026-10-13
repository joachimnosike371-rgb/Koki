// X / Twitter card image, same content as the OG card. Re-exporting
// the OG component keeps the two in sync. Next.js auto-discovers this
// file and emits <meta name="twitter:image">.

export { default } from "./opengraph-image";
export const runtime = "edge";
export { alt, size, contentType } from "./opengraph-image";
