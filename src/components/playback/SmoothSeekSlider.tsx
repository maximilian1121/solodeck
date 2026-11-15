import { SliderField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "./format";

export type SmoothSeekSliderProps = {
    positionMs: number;
    durationMs: number;
    onChange: (positionMs: number) => void;
};

export function SmoothSeekSlider({
    positionMs,
    durationMs,
    onChange,
}: SmoothSeekSliderProps) {
    const [displayPosition, setDisplayPosition] = useState(positionMs);
    const [focused, setFocused] = useState(false);
    const displayPositionRef = useRef(positionMs);

    useEffect(() => {
        const start = displayPositionRef.current;
        const distance = positionMs - start;
        if (Math.abs(distance) < 1) return;

        if (focused) {
            displayPositionRef.current = positionMs;
            setDisplayPosition(positionMs);
            return;
        }

        const duration = 220;
        let frame = 0;
        let startTime: number | undefined;

        const animate = (now: number) => {
            startTime ??= now;
            const progress = Math.min(1, (now - startTime) / duration);
            const easedProgress =
                progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
            const nextPosition = start + distance * easedProgress;
            displayPositionRef.current = nextPosition;
            setDisplayPosition(nextPosition);

            if (progress < 1) frame = window.requestAnimationFrame(animate);
        };

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            displayPositionRef.current = positionMs;
            setDisplayPosition(positionMs);
        } else {
            frame = window.requestAnimationFrame(animate);
        }

        return () => window.cancelAnimationFrame(frame);
    }, [focused, positionMs]);

    const handleChange = (nextPositionMs: number) => {
        displayPositionRef.current = nextPositionMs;
        setDisplayPosition(nextPositionMs);
        onChange(nextPositionMs);
    };

    return (
        <div
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={() => setFocused(false)}
        >
            <SliderField
                label={`${formatTime(displayPosition)} / ${formatTime(durationMs)}`}
                value={displayPosition}
                min={0}
                max={durationMs}
                step={1000}
                showValue={false}
                onChange={handleChange}
            />
        </div>
    );
}
