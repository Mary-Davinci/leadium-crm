import { memo, useMemo } from "react";

type DotLottieEmbedFrameProps = {
  active?: boolean;
  className?: string;
  loop?: boolean;
  src: string;
  stateMachineId?: string;
  title?: string;
};

export const DotLottieEmbedFrame = memo(function DotLottieEmbedFrame({
  active = true,
  className,
  loop = true,
  src,
  stateMachineId,
  title = "Animazione"
}: DotLottieEmbedFrameProps) {
  const srcDoc = useMemo(() => {
    const escapedSrc = src.replace(/"/g, "&quot;");
    const escapedStateMachineId = String(stateMachineId || "").replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      body {
        display: grid;
        place-items: center;
      }

      dotlottie-wc {
        width: 100%;
        height: 100%;
      }
    </style>
    <script
      src="https://unpkg.com/@lottiefiles/dotlottie-wc@0.9.14/dist/dotlottie-wc.js"
      type="module"
    ></script>
  </head>
  <body>
    <dotlottie-wc
      src="${escapedSrc}"
      ${escapedStateMachineId ? `stateMachineId="${escapedStateMachineId}"` : ""}
      autoplay
      ${loop ? "loop" : ""}
    ></dotlottie-wc>
  </body>
</html>`;
  }, [loop, src, stateMachineId]);

  if (!active) return null;

  return (
    <iframe
      aria-hidden="true"
      className={className}
      loading="lazy"
      scrolling="no"
      srcDoc={srcDoc}
      title={title}
    />
  );
});
