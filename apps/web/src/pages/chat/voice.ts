import { type MessageKey, type Transcription, VOICE_LIMITS } from "@zuri/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";

export type VoiceState = { phase: "idle" } | { phase: "recording"; seconds: number } | { phase: "transcribing" };

/** The recording formats the server's model reads, best first; the browser picks the first it can make. */
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

export function voiceSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** A Blob as base64, without the data: prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Voice input for the composer: one clip at a time, at most 60 s (it stops on
 * its own there) and 2 MB. The audio goes to the server to become text, which
 * lands in the composer for the owner to read and send; it is never stored.
 */
export function useVoice(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const [error, setError] = useState<{ key: MessageKey } | { message: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const started = useRef(0);
  const cancelled = useRef(false);

  const cleanup = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    for (const track of recorder.current?.stream.getTracks() ?? []) track.stop();
    recorder.current = null;
  }, []);

  // Leaving the page drops a recording in progress, and releases the microphone.
  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      cleanup();
    },
    [cleanup],
  );

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!voiceSupported()) {
      setError({ key: "web.chat.voice.unsupported" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (failure) {
      const denied = failure instanceof DOMException && (failure.name === "NotAllowedError" || failure.name === "SecurityError");
      setError({ key: denied ? "web.chat.voice.denied" : "web.chat.voice.failed" });
      return;
    }
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    let media: MediaRecorder;
    try {
      media = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setError({ key: "web.chat.voice.failed" });
      return;
    }
    const chunks: Blob[] = [];
    cancelled.current = false;
    recorder.current = media;
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = () => {
      const seconds = Math.min(VOICE_LIMITS.maxClipSeconds, Math.max(0.1, (performance.now() - started.current) / 1000));
      cleanup();
      if (cancelled.current) return;
      const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
      if (blob.size === 0) {
        setState({ phase: "idle" });
        setError({ key: "web.chat.voice.empty" });
        return;
      }
      if (blob.size > VOICE_LIMITS.maxClipBytes) {
        setState({ phase: "idle" });
        setError({ key: "web.chat.voice.failed" });
        return;
      }
      setState({ phase: "transcribing" });
      void blobToBase64(blob)
        .then((audio) => api<Transcription>("/transcribe", { method: "POST", body: { audio, seconds: Math.round(seconds * 10) / 10 } }))
        .then(
          (result) => {
            if (result.text.trim()) onText(result.text.trim());
            else setError({ key: "web.chat.voice.empty" });
          },
          (failure: unknown) => setError({ message: errorMessage(failure) }),
        )
        .finally(() => setState({ phase: "idle" }));
    };
    started.current = performance.now();
    media.start(1_000);
    setState({ phase: "recording", seconds: 0 });
    timer.current = window.setInterval(() => {
      const seconds = Math.floor((performance.now() - started.current) / 1000);
      // The clip cap: the recording ends by itself, and what was said is still sent.
      if (seconds >= VOICE_LIMITS.maxClipSeconds) {
        stop();
        return;
      }
      setState({ phase: "recording", seconds });
    }, 250);
  }, [cleanup, onText, stop]);

  return { state, error, start, stop, clearError: () => setError(null) };
}
