(function () {
  /* ===== STATE MANAGEMENT ===== */
  let lastScoredText = "";

  // Cleanup old instances
  if (document.getElementById("lps-wrapper")) document.getElementById("lps-wrapper").remove();

  /* ===== CORE HELPERS ===== */
  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function getProfileContainer() {
    const isAshby = location.hostname === "app.ashbyhq.com";
    const isLinkedInRecruiter = location.hostname.includes("linkedin.com") &&
      (location.pathname.includes("/recruiter/") || location.pathname.includes("/talent/"));

    if (isAshby) {
      // Only look inside the react-pdf document — excludes banner, sidebar, feed.
      const ashbySelectors = [
        ".react-pdf__Document",
        ".react-tabs__tab-panel--selected",
        "[data-testid='resume-panel']",
        "[data-testid='candidate-detail']",
        "[data-testid='application-detail']",
        "[data-testid='candidate-profile']",
      ];
      for (let sel of ashbySelectors) {
        const candidates = document.querySelectorAll(sel);
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          if (isVisible(el) && el.innerText.length > 200) return el;
        }
      }
      return document.body.innerText.length > 200 ? document.body : null;
    }

    if (isLinkedInRecruiter) {
      // Only target the right-side profile panel — never the left sidebar or middle list.
      // Never fall back to document.body: too much noise from project names and message previews.
      const recruiterSelectors = [
        // Primary: LinkedIn Recruiter profile panel (id/data-test confirmed from DOM inspection)
        "#profile-container",
        "[data-test-profile-container]",
        ".profile__container",
        "[data-view-name='profile-main-container']",
        // Slide-in profile panel (search results page)
        ".slide-in-panel",
        // Messaging/thread right panel fallbacks
        "[data-test-id='thread-detail']",
        "[data-test-id='message-thread-detail']",
        "[class*='thread-detail']",
        "[class*='threadDetail']",
      ];
      for (let sel of recruiterSelectors) {
        const candidates = document.querySelectorAll(sel);
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          if (isVisible(el) && el.innerText.length > 100) return el;
        }
      }
      return null; // Nothing matched — skip rather than highlight the whole page
    }

    // Standard LinkedIn (public profile, talent pipeline, etc.)
    const linkedInSelectors = [
      ".profile-presenter-layout", "[data-test-profile-container]", ".slide-in-panel",
      ".application-outlet", "[class*='profile-content']", "[class*='profile-detail']",
      "[class*='candidate-profile']", "main.scaffold-layout__main",
    ];
    for (let sel of linkedInSelectors) {
      const candidates = document.querySelectorAll(sel);
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (isVisible(el) && el.innerText.length > 200) return el;
      }
    }
    return document.body.innerText.length > 200 ? document.body : null;
  }

  /* ===== SCORING LOGIC ===== */
  function estimateYears(text) {
    let max = 0, now = new Date().getFullYear();
    const textPats = [/(\d{1,2})\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)/gi, /(?:experience|exp)\s*(?:of\s*)?(\d{1,2})\+?\s*(?:years?|yrs?)/gi];
    const datePat = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?\.?\s*(\d{4})\s*[-\u2013\u2014to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?\.?\s*(\d{4})|present|current|now)/gi;

    for (let p of textPats) {
      let m; while ((m = p.exec(text)) !== null) {
        const y = parseInt(m[1], 10); if (y > 0 && y < 50) max = Math.max(max, y);
      }
    }
    // Isolate the experience section so education start dates don't skew the range
    let expText = text;
    const expIdx = text.search(/\bexperience\b/);
    const eduIdx = text.search(/\beducation\b/);
    if (expIdx !== -1 && (eduIdx === -1 || expIdx < eduIdx)) {
      expText = text.substring(expIdx, eduIdx !== -1 ? eduIdx : text.length);
    } else if (expIdx !== -1) {
      expText = text.substring(expIdx);
    } else if (eduIdx !== -1) {
      expText = text.substring(0, eduIdx);
    }

    let earliest = now, match;
    while ((match = datePat.exec(expText)) !== null) {
      const start = parseInt(match[1], 10); if (start > 1980 && start <= now) earliest = Math.min(earliest, start);
    }
    if (earliest < now) max = Math.max(max, now - earliest);
    return Math.min(max, 40);
  }

  function cleanText(raw) {
    let text = raw
      // Strip Ashby "viewing resume for <job title> job consideration" banner
      .replace(/you.?re viewing the resume for .+? job consideration/gi, "")
      // Strip Ashby "considered for jobs" sidebar block
      .replace(/considered for jobs[\s\S]{0,300}?(?=\n{2,}|\bactivities\b|\bsummary\b|\bresume\b)/gi, "")
      // Strip stage pill text like "→ Offer • R531167"
      .replace(/→\s*\w[\w\s]*•\s*[A-Z]\d+\w*/g, "");

    if (location.hostname === "app.ashbyhq.com") {
      // On Ashby the Activity section is at the END of the PDF — strip it and everything after.
      // Do NOT apply this on LinkedIn Recruiter: "Most recent activity" appears BEFORE the
      // Summary/Experience sections, so the regex would erase all scoreable content.
      text = text
        .replace(/\bactivity\b[\s\S]*$/i, "")
        .replace(/\d{2}\/\d{2}\/\d{4},\s+[^\n]+/gi, "");
    }

    return text;
  }

  function extractBodySection(t) {
    // Returns text from the first work/experience/skills section onwards,
    // skipping the candidate header (name + current title) to avoid noise.
    const markers = [/\bexperience\b/, /\bwork history\b/, /\bemployment\b/, /\bskills\b/, /\babout\b/];
    for (let m of markers) {
      const idx = t.search(m);
      if (idx > 50) return t.substring(idx); // >50 so we don't match a word in the very first line
    }
    // Fallback: skip the first 400 chars (covers name/title/company header)
    return t.length > 400 ? t.substring(400) : t;
  }

  function scoreProfile(text) {
    const t = text.toLowerCase();
    // bodyText excludes the candidate header so title keywords don't pollute scoring
    const bodyText = extractBodySection(t);
    let total = 0, bd = [];

    // Experience
    const ye = estimateYears(t);
    const ys = ye >= 10 ? 30 : ye >= 7 ? 20 : ye >= 5 ? 10 : 0;
    total += ys; bd.push({ l: `Experience (~${ye} yrs)`, p: ys });

    // Language — scan full body (skills section may list these)
    const hj = /\bjava\b/.test(bodyText.replace(/javascript/gi, "___")), hp = /\bpython\b/.test(bodyText);
    const ls = (hj || hp) ? 15 : 0;
    const ld = []; if (hj) ld.push("Java"); if (hp) ld.push("Python");
    total += ls; bd.push({ l: `Language (${ld.length ? ld.join(", ") : "None"})`, p: ls });

    // Kubernetes — scan full body
    const hk = /\b(kubernetes|k8s|kube|helm|eks|gke|aks)\b/.test(bodyText);
    const ks = hk ? 15 : 0;
    total += ks; bd.push({ l: "Kubernetes" + (hk ? " \u2713" : ""), p: ks });

    // Data Platform — scan full body
    const dk = [
      { r: /\bdata platform\b/, w: 5 }, { r: /\bdata lake\b/, w: 4 }, { r: /\bsnowflake\b/, w: 4 },
      { r: /\bdatabricks\b/, w: 4 }, { r: /\bbigquery\b/, w: 4 }, { r: /\bdelta lake\b/, w: 4 },
      { r: /\b(etl|elt)\b/, w: 3 }, { r: /\bdistributed systems?\b/, w: 4 },
      { r: /\bdata warehouse\b/, w: 3 }, { r: /\bdata pipeline\b/, w: 3 },
      { r: /\b(spark|pyspark)\b/, w: 4 }, { r: /\bkafka\b/, w: 3 }, { r: /\bflink\b/, w: 3 },
      { r: /\bairflow\b/, w: 3 }, { r: /\b(hadoop|hdfs)\b/, w: 3 },
      { r: /\bredshift\b/, w: 3 }, { r: /\bdata engineering\b/, w: 3 },
      { r: /\bdata infrastructure\b/, w: 4 }, { r: /\blakehouse\b/, w: 3 },
      { r: /\biceberg\b/, w: 3 }, { r: /\bdbt\b/, w: 2 }
    ];
    let ds = 0, dmc = 0;
    for (let item of dk) { if (item.r.test(bodyText)) { ds += item.w; dmc++; } }
    ds = Math.min(ds, 25); total += ds;
    bd.push({ l: `Data Platform (${dmc} found)`, p: ds });

    // Seniority — scope to body only so current job title in header doesn't score
    const sk = [
      { r: /\barchitect\b/, w: 4 }, { r: /\bstaff (engineer|software)\b/, w: 5 },
      { r: /\bprincipal\b/, w: 5 }, { r: /\btech(nical)? lead\b/, w: 4 },
      { r: /\bscalability\b/, w: 3 }, { r: /\bsystem design\b/, w: 3 },
      { r: /\bplatform lead\b/, w: 4 }, { r: /\bengineering manager\b/, w: 3 },
      { r: /\bmentoring\b/, w: 2 }
    ];
    let ss = 0, smc = 0;
    for (let item of sk) { if (item.r.test(bodyText)) { ss += item.w; smc++; } }
    ss = Math.min(ss, 15); total += ss;
    bd.push({ l: `Seniority (${smc} found)`, p: ss });

    total = Math.min(total, 100);
    const tier = total >= 70 ? "Strong Fit" : total >= 40 ? "Moderate Fit" : "Weak Fit";
    return { score: total, tier, breakdown: bd };
  }

  /* ===== HIGHLIGHTING ===== */
  function highlightKeywords(targetContainer) {
    if (!targetContainer) return 0;
    targetContainer.querySelectorAll(".lps-hl").forEach(el => el.outerHTML = el.textContent);

    const COLORS = {
      language: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af" },
      k8s: { bg: "#dcfce7", border: "#22c55e", text: "#166534" },
      data: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e" },
      seniority: { bg: "#f3e8ff", border: "#a855f7", text: "#6b21a8" }
    };
    const GROUPS = {
      language: ["python", "java"],
      k8s: ["kubernetes", "k8s", "helm", "eks", "gke", "aks"],
      data: ["data platform", "data lake", "snowflake", "databricks", "bigquery", "delta lake", "etl", "elt", "distributed systems", "data warehouse", "data pipeline", "spark", "pyspark", "kafka", "flink", "airflow", "hadoop", "hdfs", "redshift", "data engineering", "data infrastructure", "lakehouse", "iceberg", "dbt", "presto", "trino"],
      seniority: ["architect", "staff engineer", "staff software", "principal", "tech lead", "technical lead", "scalability", "system design", "platform lead", "engineering manager", "mentoring", "technical strategy"]
    };
    const allKw = [];
    for (let cat in GROUPS) GROUPS[cat].forEach(w => allKw.push({ word: w, cat: cat }));
    allKw.sort((a, b) => b.word.length - a.word.length);

    let count = 0;
    // Track when we've entered the Activity section so we stop highlighting there
    let inActivitySection = false;
    function processNode(node) {
      if (node.nodeType !== 3) return;
      const text = node.textContent, textLower = text.toLowerCase();
      // Stop highlighting once we hit the Ashby Activity section in the PDF
      if (/^\s*activity\s*$/.test(textLower)) { inActivitySection = true; return; }
      if (inActivitySection) return;
      // Skip Ashby activity log lines (date-stamped audit entries)
      if (/^\d{2}\/\d{2}\/\d{4},\s/.test(text.trim())) return;
      for (let k of allKw) {
        if (k.word === "java" && textLower.includes("javascript")) continue;
        const idx = textLower.indexOf(k.word);
        if (idx !== -1) {
          const matchText = text.substr(idx, k.word.length);
          const afterText = text.substr(idx + k.word.length);
          const span = document.createElement("span");
          span.className = "lps-hl";
          span.textContent = matchText;
          const c = COLORS[k.cat];
          span.style.cssText = `background:${c.bg};border:1px solid ${c.border};border-radius:3px;padding:0 2px;color:${c.text};font-weight:600;`;
          const afterNode = document.createTextNode(afterText);
          node.textContent = text.substr(0, idx);
          node.parentNode.insertBefore(span, node.nextSibling);
          node.parentNode.insertBefore(afterNode, span.nextSibling);
          count++;
          processNode(afterNode);
          return;
        }
      }
    }
    const walker = document.createTreeWalker(targetContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.parentNode.tagName === "SCRIPT" || n.parentNode.tagName === "STYLE" || n.parentNode.closest("#lps-wrapper")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(processNode);
    return count;
  }

  /* ===== UI CONSTRUCTION ===== */
  const wrapper = document.createElement("div");
  wrapper.id = "lps-wrapper";
  document.body.appendChild(wrapper);

  // 1. The Docked Tab
  const tab = document.createElement("div");
  tab.id = "lps-tab";
  tab.textContent = "🎯";
  tab.title = "Click to expand score";
  tab.style.cssText = "position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:9999998;background:#0ea5e9;color:white;width:32px;height:48px;border-radius:8px 0 0 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:-2px 0 10px rgba(0,0,0,0.2);transition:0.2s;";
  wrapper.appendChild(tab);

  // 2. The Main Panel (Floating, Centered, Bigger Fonts)
  const panel = document.createElement("div");
  panel.id = "lps-panel";
  panel.style.cssText = "position:fixed;top:50%;right:20px;width:300px;height:auto;max-height:85vh;z-index:9999999;background:rgba(15, 23, 42, 0.98);backdrop-filter:blur(8px);color:#e2e8f0;box-shadow:0 10px 40px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;border:1px solid #334155;border-radius:12px;overflow:hidden;transform:translate(120%, -50%);transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);";

  panel.innerHTML = `
    <div style="padding:14px;border-bottom:1px solid #1e293b;background:#1e293b;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-weight:700;color:#38bdf8;font-size:16px;">Auto Scorer</div>
      <button id="lps-min" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;padding:4px;">✕</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:16px;">
      <div id="lps-status" style="text-align:center;font-size:13px;color:#64748b;margin-bottom:8px;">Waiting for profile...</div>
      <div id="lps-result" style="display:none;"></div>
    </div>
  `;
  wrapper.appendChild(panel);

  /* ===== UI ACTIONS ===== */
  function openPanel() {
    panel.style.transform = "translate(0, -50%)";
    tab.style.display = "none";
  }
  function closePanel() {
    panel.style.transform = "translate(120%, -50%)";
    tab.style.display = "flex";
  }

  tab.onclick = openPanel;
  panel.querySelector("#lps-min").onclick = closePanel;

  /* ===== AUTO-RUNNER ===== */
  function runAnalysis() {
    const container = getProfileContainer();
    if (!container) return;

    const text = container.innerText;
    if (lastScoredText && Math.abs(text.length - lastScoredText.length) < 20) return;

    lastScoredText = text;

    // SCORE
    const result = scoreProfile(cleanText(text));

    // Highlight container: must be strictly scoped so we never walk sidebar/feed nodes.
    // - Ashby: always use .react-pdf__Document (PDF text layers only).
    // - LinkedIn Recruiter: container is already the right-panel-only element from getProfileContainer().
    // - Standard LinkedIn: container is already a scoped profile element.
    let hlContainer = container;
    if (location.hostname === "app.ashbyhq.com") {
      hlContainer = document.querySelector(".react-pdf__Document") || null;
    }
    const hlCount = hlContainer ? highlightKeywords(hlContainer) : 0;

    // UPDATE UI
    const statusDiv = document.getElementById("lps-status");
    const resDiv = document.getElementById("lps-result");
    const tabDiv = document.getElementById("lps-tab");

    statusDiv.textContent = "";

    const color = result.tier === "Strong Fit" ? "#4ade80" : result.tier === "Moderate Fit" ? "#facc15" : "#f87171";

    // Update Tab Preview (Small badge)
    tabDiv.innerHTML = `<div style="font-size:12px;font-weight:800;">${result.score}</div>`;
    tabDiv.style.background = color === "#4ade80" ? "#22c55e" : color === "#facc15" ? "#eab308" : "#ef4444";

    // Update Full Panel - BIG FONTS
    let html = `
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:64px;line-height:1;font-weight:800;color:${color}">${result.score}</div>
        <div style="font-size:14px;color:${color};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">${result.tier}</div>
      </div>
      <div style="background:rgba(30, 41, 59, 0.5);border-radius:8px;padding:12px;border:1px solid #334155;">
    `;
    result.breakdown.forEach(b => {
        html += `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:4px;">
          <span style="color:#e2e8f0;font-weight:500;">${b.l}</span>
          <span style="color:${b.p > 0 ? '#38bdf8' : '#64748b'};font-weight:700;">+${b.p}</span>
        </div>`;
    });
    html += `</div>`;
    if (hlCount > 0) html += `<div style="text-align:center;margin-top:12px;font-size:12px;color:#38bdf8;font-weight:500;">✨ ${hlCount} keywords found</div>`;

    resDiv.innerHTML = html;
    resDiv.style.display = "block";
  }

  const observer = new MutationObserver((mutations) => {
    clearTimeout(window.lpsDebounce);
    window.lpsDebounce = setTimeout(runAnalysis, 1000);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  // Fire sooner, then retry after 3s and 6s to catch SPA lazy-loaded content
  setTimeout(runAnalysis, 1500);
  setTimeout(runAnalysis, 3000);
  setTimeout(runAnalysis, 6000);
})();
