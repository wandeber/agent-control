"use client";

import React from "react";
import type { FlowEvidenceView } from "../lib/flow-evidence";

export function FlowEvidenceDetails({ view, expanded = false }: { view: FlowEvidenceView; expanded?: boolean }) {
  return <details className="flow-evidence-details min-w-0 rounded-lg border border-slate-200 bg-white text-xs" open={expanded}>
    <summary className="cursor-pointer px-3 py-2 font-semibold text-slate-800">
      {view.title} · {view.decision ? "Decision needed" : view.history ? "Earlier attempt" : view.waitingLabel ?? "Phase details"}
    </summary>
    <div className="max-h-72 space-y-3 overflow-auto border-t border-slate-100 px-3 py-3 leading-5">
      {view.decision ? <div className="rounded-md bg-amber-50 px-3 py-2 text-amber-900" role="status">
        <p className="font-semibold">Waiting for your decision: {view.decision}</p>
        <p>Reply in the Codex conversation to continue.</p>
      </div> : null}
      {view.continuation ? <p className="text-amber-800">{view.continuation}</p> : null}
      {view.recovery ? <div className="border-l-2 border-amber-400 pl-3">
        <p className="font-semibold text-slate-800">Flow recovery</p>
        <p className="whitespace-pre-wrap break-words text-slate-600">{view.recovery.reason}</p>
        {view.recovery.fullReviewRequired ? <p className="text-amber-800">The new owner must complete a full review before this flow can advance.</p> : null}
      </div> : null}
      {view.correction ? <div className="border-l-2 border-amber-400 pl-3">
        <p className="font-semibold text-slate-800">{view.correction.title}</p>
        <p className="whitespace-pre-wrap break-words text-slate-600">{view.correction.text}</p>
      </div> : null}
      {view.history ? <p className="text-slate-500">This is an earlier attempt. Its records do not establish the current result.</p> : null}
      {view.receipts.length === 0 ? <p className="text-slate-500">
        {view.available ? "No verified evidence is recorded for this attempt." : "This run has no verified evidence ledger. A completed phase records progress, not validation of the current result."}
      </p> : <>
        <p className="text-slate-500">Evidence recorded for this attempt. Later changes may require a new review.</p>
        {view.receipts.map((receipt, index) => <section className="space-y-2" key={`${receipt.title}-${index}`} aria-label={receipt.title}>
          <p className="font-semibold text-slate-800">{receipt.title} · {receipt.status}</p>
          {receipt.notice ? <p className="text-amber-800">{receipt.notice}</p> : null}
          {receipt.reason ? <p className="whitespace-pre-wrap break-words text-slate-600">{receipt.reason}</p> : null}
          {receipt.sections.map((section) => <div key={section.title}>
            <p className="font-medium text-slate-700">{section.title}</p>
            <ul className="list-disc space-y-1 pl-4 text-slate-600">{section.items.map((item) => <li className="break-words" key={item}>{item}</li>)}</ul>
          </div>)}
        </section>)}
      </>}
      {view.unscopedEvidence ? <p className="text-slate-500">Other flow evidence has no recorded producing attempt and is not attributed to this phase.</p> : null}
    </div>
  </details>;
}
