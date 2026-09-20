// Keep the decision to report a handled failure separate from the UI. This is
// shared by live monitoring and evaluation, and lets cancellation stay quiet.
export function reportUnexpectedError(error, report, tags) {
  if (error?.name === "AbortError") return false;
  report(error, tags);
  return true;
}
