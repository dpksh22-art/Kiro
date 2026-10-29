"use client";
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="content"><div className="card card-pad"><p className="eyebrow">Unexpected error</p><h1>This view could not be loaded</h1><p className="subtitle">Reference: {error.digest ?? "local"}</p><button className="button" onClick={reset}>Try again</button></div></main>;
}
