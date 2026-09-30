import toast, { type ToastOptions } from "react-hot-toast";

const SOUND_STORAGE_KEY = "flowfi-transaction-sounds";
let lastSoundAt = 0;

export function playTransactionSuccessSound(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SOUND_STORAGE_KEY) !== "true") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (Date.now() - lastSoundAt < 700) return;
  lastSoundAt = Date.now();

  try {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    master.connect(context.destination);

    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const note = context.createGain();
      const start = now + index * 0.13;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      note.gain.setValueAtTime(0.0001, start);
      note.gain.exponentialRampToValueAtTime(0.7, start + 0.02);
      note.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      oscillator.connect(note);
      note.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.25);
    });

    window.setTimeout(() => void context.close(), 600);
  } catch {
    // Sound is optional; autoplay restrictions must never interrupt a payment flow.
  }
}

export function transactionSuccessToast(
  message: string,
  options?: ToastOptions
): string {
  playTransactionSuccessSound();
  // Only forward options when they exist: `toast.success(msg, undefined)` is
  // equivalent at runtime, but the explicit second argument breaks callers
  // (and tests) that match against the single-argument call.
  return options ? toast.success(message, options) : toast.success(message);
}

export { SOUND_STORAGE_KEY };
