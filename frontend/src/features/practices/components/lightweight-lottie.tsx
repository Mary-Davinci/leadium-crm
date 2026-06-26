import { memo, useEffect, useId, useRef } from "react";
import type { AnimationConfigWithData, AnimationItem, RendererType } from "lottie-web";

type LightweightLottieProps = {
  active?: boolean;
  animationData: unknown;
  autoplay?: boolean;
  className?: string;
  loop?: boolean | number;
  onComplete?: () => void;
  playSegment?: [number, number];
  preserveAspectRatio?: string;
  suspendWhenHidden?: boolean;
  quality?: "high" | "medium" | "low";
  renderer?: RendererType;
  speed?: number;
  stopFrame?: number;
};

export const LightweightLottie = memo(function LightweightLottie({
  active = true,
  animationData,
  autoplay = true,
  className,
  loop = true,
  onComplete,
  playSegment,
  preserveAspectRatio = "xMidYMid meet",
  suspendWhenHidden = true,
  quality = "medium",
  renderer = "svg",
  speed = 1,
  stopFrame
}: LightweightLottieProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<AnimationItem | null>(null);
  const animationId = useId();
  const hasCompletedRef = useRef(false);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    let cancelled = false;
    let cleanupComplete: (() => void) | null = null;
    let cleanupDomLoaded: (() => void) | null = null;
    let cleanupEnterFrame: (() => void) | null = null;

    import("lottie-web")
      .then(({ default: lottie }) => {
        if (cancelled || !containerRef.current) return;

        lottie.setQuality(quality);

        const instance = lottie.loadAnimation({
          animationData,
          autoplay,
          container: containerRef.current,
          loop,
          name: animationId,
          renderer,
          rendererSettings: {
            clearCanvas: renderer === "canvas",
            hideOnTransparent: true,
            preserveAspectRatio,
            progressiveLoad: true
          }
        } as AnimationConfigWithData<RendererType>);

        animationRef.current = instance;
        instance.setSubframe(false);
        instance.setSpeed(speed);
        hasCompletedRef.current = false;

        cleanupDomLoaded = instance.addEventListener("DOMLoaded", () => {
          if (playSegment) {
            instance.playSegments(playSegment, true);
            return;
          }
          if (stopFrame !== undefined) {
            instance.goToAndStop(stopFrame, true);
          }
        });

        if (playSegment && stopFrame !== undefined) {
          cleanupEnterFrame = instance.addEventListener("enterFrame", () => {
            if (hasCompletedRef.current) return;
            if (instance.currentFrame >= stopFrame - 0.35) {
              hasCompletedRef.current = true;
              onComplete?.();
              instance.goToAndStop(stopFrame, true);
            }
          });
        } else if (playSegment) {
          cleanupComplete = instance.addEventListener("complete", () => {
            onComplete?.();
            if (loop) {
              instance.playSegments(playSegment, true);
            }
          });
        }
      })
      .catch(() => null);

    return () => {
      cancelled = true;
      cleanupComplete?.();
      cleanupDomLoaded?.();
      cleanupEnterFrame?.();
      animationRef.current?.destroy();
      animationRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [active, animationData, animationId, autoplay, loop, onComplete, playSegment, preserveAspectRatio, quality, renderer, speed, stopFrame]);

  useEffect(() => {
    if (!active || !suspendWhenHidden || !containerRef.current) return;

    const node = containerRef.current;
    let isInViewport = true;

    const syncPlayback = () => {
      const animation = animationRef.current;
      if (!animation) return;

      const isDocumentVisible = typeof document === "undefined" ? true : document.visibilityState === "visible";
      const shouldPlay = isInViewport && isDocumentVisible;

      if (shouldPlay) {
        if (stopFrame !== undefined && playSegment && hasCompletedRef.current) {
          animation.goToAndStop(stopFrame, true);
          return;
        }
        if (stopFrame !== undefined && !playSegment && !autoplay) {
          animation.goToAndStop(stopFrame, true);
          return;
        }
        if (stopFrame !== undefined && playSegment && !autoplay) {
          return;
        }
        animation.play();
        return;
      }

      animation.pause();
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        isInViewport = Boolean(entry?.isIntersecting);
        syncPlayback();
      },
      { threshold: 0.12 }
    );

    const handleVisibilityChange = () => {
      syncPlayback();
    };

    observer.observe(node);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    syncPlayback();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, playSegment, stopFrame, suspendWhenHidden]);

  return <div ref={containerRef} className={className} aria-hidden="true" />;
});
