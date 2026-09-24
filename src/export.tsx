import React from "react";
import { createRoot } from "react-dom/client";
import "./ui.css";
import { SessionDetail } from "./ui/session-view";
const data = window.__AGENT_ATLAS_EXPORT__;
createRoot(document.getElementById("root")).render(<SessionDetail tree={data.tree} info={data.info} workspace={data.workspace} live={false} backHref="#" />);
