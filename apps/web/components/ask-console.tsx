"use client";

import { useState } from "react";

import { answer } from "../lib/demo-data";
import { Confidence, Panel, PanelHeader, SourceRef } from "./ui";

export function AskConsole() {
  const [question, setQuestion] = useState("What happens when a user logs in?");
  const [submitted, setSubmitted] = useState(true);
  return (
    <div className="ask-layout">
      <Panel className="question-history">
        <PanelHeader eyebrow="SESSION" title="Recent questions" />
        <button className="history-item active" type="button">
          <span>Q</span>
          <div>
            <strong>What happens when a user logs in?</strong>
            <small>endpoint_flow · now</small>
          </div>
        </button>
        <button className="history-item" type="button">
          <span>Q</span>
          <div>
            <strong>Where is JWT expiration configured?</strong>
            <small>configuration_usage · 4m</small>
          </div>
        </button>
        <button className="history-item" type="button">
          <span>Q</span>
          <div>
            <strong>Which tests cover AuthService?</strong>
            <small>test_impact · 7m</small>
          </div>
        </button>
      </Panel>
      <div className="conversation">
        <Panel className="answer-panel">
          <div className="question-bubble">
            <span>YOU</span>
            <p>{question}</p>
          </div>
          {submitted ? (
            <div className="answer-block">
              <div className="answer-meta">
                <span>INTELLIREPO</span>
                <Confidence level={answer.confidence} />
                <b>DETERMINISTIC MODE</b>
              </div>
              <p>{answer.text}</p>
              <div className="evidence-pack">
                <div>
                  <span>EVIDENCE PACK</span>
                  <strong>3 references · 5 nodes · PostgreSQL</strong>
                </div>
                {answer.citations.map(([id, path, evidence]) => (
                  <article key={id}>
                    <b>{id}</b>
                    <div>
                      <SourceRef>{path}</SourceRef>
                      <p>{evidence}</p>
                    </div>
                  </article>
                ))}
              </div>
              <div className="degraded-banner">
                <span>!</span>
                <div>
                  <strong>Natural-language synthesis unavailable</strong>
                  <p>
                    Ollama is offline. This response was rendered from confirmed structural
                    evidence; semantic-only recall is unavailable.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-answer">
              Submit the question to retrieve revision-scoped evidence.
            </div>
          )}
        </Panel>
        <form
          className="ask-box"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
          }}
        >
          <textarea
            aria-label="Ask about this repository"
            onChange={(event) => {
              setQuestion(event.target.value);
              setSubmitted(false);
            }}
            value={question}
          />
          <div>
            <span>REVISION 9f2c71a · LOCAL ONLY</span>
            <button type="submit">ASK INTELLIREPO ↗</button>
          </div>
        </form>
      </div>
    </div>
  );
}
