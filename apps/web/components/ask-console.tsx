"use client";

import { useState } from "react";
import type { QuestionTaskResponse } from "@intellirepo/contracts";
import type { RepositoryAnswer } from "@intellirepo/qa";

import { ProductApiClient } from "../lib/product-api";
import { Confidence, Panel, PanelHeader, SourceRef } from "./ui";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function AskConsole({ repositoryId }: { readonly repositoryId: string }) {
  const [question, setQuestion] = useState("What happens when a user logs in?");
  const [task, setTask] = useState<QuestionTaskResponse<RepositoryAnswer>>();
  const [error, setError] = useState<string>();

  const ask = async (): Promise<void> => {
    setError(undefined);
    try {
      const client = new ProductApiClient();
      let current = (await client.submitQuestion(repositoryId, {
        question,
      })) as QuestionTaskResponse<RepositoryAnswer>;
      setTask(current);
      for (
        let attempt = 0;
        attempt < 120 && (current.state === "queued" || current.state === "running");
        attempt += 1
      ) {
        await delay(500);
        current = (await client.question(
          repositoryId,
          current.id,
        )) as QuestionTaskResponse<RepositoryAnswer>;
        setTask(current);
      }
      if (current.state === "failed") setError(current.error ?? "Question failed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Question request failed");
    }
  };
  const answer = task?.result;
  return (
    <div className="ask-layout live-ask-layout">
      <Panel className="question-history">
        <PanelHeader eyebrow="DURABLE TASK" title="Current request" />
        <div className="task-state">
          <span
            className={`status-dot status-${task?.state === "failed" ? "failed" : task?.state === "succeeded" ? "current" : "stale"}`}
          />
          <strong>{task?.state ?? "not submitted"}</strong>
          <code>{task?.id ?? "—"}</code>
        </div>
      </Panel>
      <div className="conversation">
        <Panel className="answer-panel">
          <div className="question-bubble">
            <span>YOU</span>
            <p>{question}</p>
          </div>
          {answer === undefined ? (
            <div className="empty-answer">
              {error ?? "Submit the question to retrieve revision-scoped evidence."}
            </div>
          ) : (
            <div className="answer-block">
              <div className="answer-meta">
                <span>INTELLIREPO</span>
                <Confidence level={answer.confidence} />
                {answer.degraded ? <b>DEGRADED</b> : <b>HYBRID</b>}
              </div>
              <p>{answer.answer}</p>
              <div className="evidence-pack">
                <div>
                  <span>EVIDENCE PACK</span>
                  <strong>
                    {answer.citations.length} references · {answer.evidence.nodes.length} nodes ·{" "}
                    {answer.evidence.adapter ?? "semantic"}
                  </strong>
                </div>
                {answer.citations.map((citation) => (
                  <article key={citation.id}>
                    <b>{citation.id}</b>
                    <div>
                      <SourceRef>
                        {citation.path}
                        {citation.startLine === undefined ? "" : `:${citation.startLine}`}
                      </SourceRef>
                      <p>{citation.evidence}</p>
                    </div>
                  </article>
                ))}
              </div>
              {answer.degradedReasons.length > 0 ? (
                <div className="degraded-banner">
                  <span>!</span>
                  <div>
                    <strong>Capability degradation</strong>
                    <p>{answer.degradedReasons.join(" · ")}</p>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </Panel>
        <form
          className="ask-box"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <textarea
            aria-label="Ask about this repository"
            onChange={(event) => setQuestion(event.target.value)}
            value={question}
          />
          <div>
            <span>ACTIVE CANONICAL REVISION · LOCAL ONLY</span>
            <button disabled={task?.state === "queued" || task?.state === "running"} type="submit">
              ASK INTELLIREPO ↗
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
