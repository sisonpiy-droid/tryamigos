import type { MetadataRoute } from "next";

/* What makes MUSE installable. On an iPhone this is not optional for
   outreach: Safari only delivers web push to a site added to the Home Screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MUSE",
    short_name: "MUSE",
    description: "AI personalities who remember you.",
    start_url: "/solo",
    scope: "/",
    display: "standalone",
    background_color: "#0E0D12",
    theme_color: "#0E0D12",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
