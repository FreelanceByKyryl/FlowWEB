(() => {
  "use strict";

  const devices = [
    { id: "desktop", name: "Desktop", width: 1920, height: 1080, icon: "monitor" },
    { id: "laptop", name: "Laptop", width: 1440, height: 900, icon: "laptop" },
    { id: "tablet", name: "Tablet", width: 768, height: 1024, icon: "tablet" },
    { id: "mobile", name: "Mobile", width: 390, height: 844, icon: "smartphone" },
    { id: "custom", name: "Custom", icon: "sliders-horizontal" }
  ];

  const settingsByView = new Map();
  const screenshotDrafts = [];
  const mockupAssets = new Map();
  const artworkDrafts = new Map();
  let activeJob;
  let liveSession;
  let activeMockupTab = "mockup";

  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const checked = (value) => value ? " checked" : "";
  const selected = (value) => value ? " selected" : "";
  const query = (root, name) => root.querySelector(`[data-role="${name}"]`);
  const projectById = (ctx, id) => ctx.state.projects.find((project) => project.id === id);

  function safeImage(source) {
    return typeof source === "string" && /^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(source) ? source : "";
  }

  function createButton(label, id, glyph, style = "secondary", disabled = false) {
    return `<button class="button ${style}" type="button" data-role="${id}"${disabled ? " disabled" : ""}>${icon(glyph)}<span>${label}</span></button>`;
  }

  function previewPlaceholder(glyph, title, message) {
    return `<div class="empty-state"><div class="empty-icon">${icon(glyph)}</div><h3>${title}</h3><p class="muted">${message}</p></div>`;
  }

  function projectOptions(ctx, id, noneLabel = "") {
    return `${noneLabel ? `<option value="">${noneLabel}</option>` : ""}
      ${ctx.state.projects.map((project) => `<option value="${ctx.escape(project.id)}"${selected(project.id === id)}>${ctx.escape(project.name)}</option>`).join("")}`;
  }

  function defaultProject(ctx, saved) {
    return projectById(ctx, ctx.state.selectedProjectId)?.id ??
      (saved?.projectId === "" ? "" : projectById(ctx, saved?.projectId)?.id) ?? ctx.state.projects[0]?.id ?? "";
  }

  function field(label, control, extra = "") {
    return `<label class="field ${extra}"><span>${label}</span>${control}</label>`;
  }

  function number(name, value, min, max, step = 1) {
    return `<input type="number" name="${name}" min="${min}" max="${max}" step="${step}" value="${Number(value)}" required>`;
  }

  function select(name, value, choices) {
    return `<select name="${name}">${choices.map(([id, label]) => `<option value="${id}"${selected(id === value)}>${label}</option>`).join("")}</select>`;
  }

  function checkbox(name, label, value) {
    return `<label class="check-row"><input type="checkbox" name="${name}"${checked(value)}><span>${label}</span></label>`;
  }

  function group(label, controls) {
    return `<fieldset class="control-group"><legend>${label}</legend>${controls}</fieldset>`;
  }

  function dimensionFields(width, height, min = 160, max = 4096, widthName = "width", heightName = "height") {
    const step = widthName === "outputWidth" ? 2 : 1;
    return `<div class="form-grid">${field("Width", number(widthName, width, min, max, step))}
      ${field("Height", number(heightName, height, min, max, step))}</div>`;
  }

  function jobStatus() {
    return `<div class="studio-status" data-role="job-status" hidden>
      <div class="preview-toolbar"><span data-role="stage" role="status" aria-live="polite"></span>
        ${createButton("Cancel", "cancel", "x", "ghost")}</div>
      <progress class="progress" data-role="progress" aria-label="Studio job progress" max="100"></progress>
    </div>`;
  }

  function getFormValues(form) {
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      if (input.name && input.name !== "device") data[input.name] = input.checked;
    });
    form.querySelectorAll('input[type="number"],input[type="range"]').forEach((input) => {
      if (!input.disabled && input.name) data[input.name] = input.valueAsNumber;
    });
    return data;
  }

  function assertValid(form) {
    if (!form.reportValidity()) throw new Error("Check the highlighted settings before continuing.");
  }

  function changeProgress(root, stage, value) {
    query(root, "stage").textContent = stage;
    const meter = query(root, "progress");
    if (Number.isFinite(value)) meter.value = Math.min(100, Math.max(0, value));
    else meter.removeAttribute("value");
  }

  function paintJob(ctx, root, job) {
    const status = query(root, "job-status");
    const cancel = query(root, "cancel");
    job.root = root;
    status.hidden = job.quiet;
    root.setAttribute("aria-busy", "true");
    cancel.hidden = !job.cancellable;
    cancel.disabled = job.cancelled;
    changeProgress(root, job.stage, job.progress);
    cancel.onclick = async () => {
      cancel.disabled = true;
      job.cancelled = true;
      job.stage = "Cancelling…";
      job.progress = undefined;
      changeProgress(root, job.stage, job.progress);
      try {
        await ctx.api.cancelStudio();
      } catch (error) {
        ctx.failure(error);
      }
    };
  }

  function resumeProgress(ctx, root) {
    if (activeJob) paintJob(ctx, root, activeJob);
  }

  async function execute(ctx, root, label, operation, { quiet = false, cancellable = true } = {}) {
    if (activeJob) {
      if (!quiet) ctx.notify("A studio operation is already running.", "info");
      return undefined;
    }

    const job = { root, stage: label, cancelled: false, quiet, cancellable };
    activeJob = job;
    paintJob(ctx, root, job);
    const unsubscribe = ctx.api.onStudioProgress?.(({ stage, progress }) => {
      if (job.cancelled) return;
      job.stage = stage || label;
      job.progress = progress;
      if (job.root.isConnected) changeProgress(job.root, job.stage, progress);
    });

    try {
      const result = await operation(job);
      return result;
    } catch (error) {
      if (!quiet || /cancel/i.test(error.message)) ctx.failure(error);
      else throw error;
      return undefined;
    } finally {
      if (typeof unsubscribe === "function") unsubscribe();
      activeJob = undefined;
      job.root.removeAttribute("aria-busy");
      query(job.root, "job-status").hidden = true;
      query(job.root, "cancel").onclick = null;
    }
  }

  function websiteInput(ctx, id, url) {
    return `<div class="stack">
      ${field("Project", `<select name="projectId">${projectOptions(ctx, id, "Use a website URL")}</select>`)}
      ${field("Website URL", `<input name="url" type="text" inputmode="url" maxlength="2048" spellcheck="false" placeholder="https://example.com" value="${ctx.escape(url || "")}" required>`)}
    </div>`;
  }

  function watchProjectUrl(ctx, form) {
    form.elements.projectId.addEventListener("change", () => {
      ctx.state.selectedProjectId = form.elements.projectId.value;
      form.elements.url.value = projectById(ctx, form.elements.projectId.value)?.url || "";
    });
  }

  function imagePreview(ctx, draft, alt, fallback) {
    const preview = safeImage(draft?.preview);
    return preview ? `<img class="preview-image" src="${ctx.escape(preview)}" alt="${alt}">` : fallback;
  }

  function openedManualSession() {
    return `<div class="studio-status" role="status">${icon("external-link")}<span>Live Chromium preview is open. Interact with the page, then capture it here.</span></div>`;
  }

  async function refreshData(ctx) {
    try {
      await ctx.load();
    } catch (error) {
      ctx.failure(error);
    }
  }

  function screenshots(ctx) {
    const saved = settingsByView.get("screenshots");
    const projectId = defaultProject(ctx, saved);
    const project = projectById(ctx, projectId);
    const options = {
      devices: [ctx.state.settings.screenshotWidth === 1920 && ctx.state.settings.screenshotHeight === 1080 ? "desktop" : "custom"],
      width: ctx.state.settings.screenshotWidth || 1920,
      height: ctx.state.settings.screenshotHeight || 1080,
      format: "png",
      quality: ctx.state.settings.imageQuality || 90,
      dpr: 1,
      delay: 0,
      fullPage: false,
      waitForAssets: true,
      lazy: false,
      dismissCookies: false,
      ...saved,
      projectId,
      url: projectId === saved?.projectId ? saved.url : project?.url
    };
    let currentDraft = screenshotDrafts.findLast((item) => item.projectId === options.projectId);
    ctx.view.innerHTML = `${ctx.heading("Screenshot Studio", "Capture websites at the sizes you want to present.")}
      <div class="studio-grid" data-role="studio">
        <form class="panel studio-controls" data-role="form">
          ${group("Website", websiteInput(ctx, options.projectId, options.url))}
          ${group("Device viewports", `<div class="segmented">${devices.map((device) => `
            <label${device.width ? ` title="${device.width} × ${device.height}"` : ""}><input type="checkbox" name="device" value="${device.id}"${checked(options.devices.includes(device.id))}>
              <span>${icon(device.icon)}${device.name}</span></label>`).join("")}</div>
            <div data-role="custom-dimensions"${options.devices.includes("custom") ? "" : " hidden"}>
              ${dimensionFields(options.width, options.height)}</div>`)}
          ${group("Capture options", `
            <div class="form-grid">${field("File type", select("format", options.format, [["png", "PNG"], ["jpeg", "JPEG"]]))}
            ${field("JPEG quality", number("quality", options.quality, 1, 100))}
            ${field("Pixel ratio", number("dpr", options.dpr, 0.5, 3, 0.5))}
            ${field("Load delay (ms)", number("delay", options.delay, 0, 30000))}</div>
            ${checkbox("fullPage", "Capture full page", options.fullPage)}
            ${checkbox("waitForAssets", "Wait for fonts and images", options.waitForAssets)}
            ${checkbox("lazy", "Load lazy content before capture", options.lazy)}
            ${checkbox("dismissCookies", "Dismiss known cookie banners", options.dismissCookies)}`)}
          <div class="actions">
            <button class="button primary" type="submit">${icon("camera")}<span>Capture</span></button>
            ${createButton("Live preview", "live", "external-link")}
          </div>
          <div data-role="manual-notice"></div>
        </form>
        <section class="panel studio-preview" aria-label="Screenshot preview">
          <div class="panel-heading preview-toolbar"><h2>Capture preview</h2>
            <div class="actions" data-role="export-actions"></div>
          </div>
          <div class="preview-stage" data-role="canvas"></div>
          <div class="preview-toolbar" data-role="captures"></div>
          ${jobStatus()}
        </section>
      </div>`;

    const root = query(ctx.view, "studio");
    const form = query(root, "form");
    const canvas = query(root, "canvas");
    const choices = query(root, "captures");
    const exportActions = query(root, "export-actions");
    const manualNotice = query(root, "manual-notice");
    resumeProgress(ctx, root);

    function read() {
      return {
        ...getFormValues(form),
        devices: new FormData(form).getAll("device")
      };
    }

    function screenOptions({ devices: _selectedDevices, ...data }, deviceId) {
      const preset = devices.find((device) => device.id === deviceId);
      return {
        ...data,
        device: deviceId,
        width: preset?.width || data.width,
        height: preset?.height || data.height,
        manualId: liveSession?.url === data.url && liveSession.device === deviceId ? liveSession.id : undefined
      };
    }

    function relatedDrafts() {
      return screenshotDrafts.filter((item) => item.projectId === form.elements.projectId.value &&
        (item.projectId || item.url === form.elements.url.value));
    }

    function renderPreview() {
      const related = relatedDrafts();
      if (!related.includes(currentDraft)) currentDraft = related.at(-1);
      canvas.innerHTML = imagePreview(ctx, currentDraft, "Captured website", previewPlaceholder(
        "camera", "No capture yet", "Capture the configured website to inspect the image here."
      ));
      exportActions.innerHTML = currentDraft ? `${currentDraft.exportId ? createButton("Open image", "open", "external-link") : createButton("Save image", "save", "download", "primary", currentDraft.saved)}
         ${related.filter((item) => !item.saved).length > 1 ? createButton("Save all", "save-all", "images") : ""}` : "";
      choices.innerHTML = related.map((item, index) =>
        `<button type="button" class="button ${item === currentDraft ? "secondary" : "ghost"}" data-capture-index="${index}" aria-pressed="${item === currentDraft}">${ctx.escape(item.label)}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ""}${item.saved ? " · Saved" : ""}</button>`
      ).join("");
      choices.hidden = related.length === 0;
      choices.querySelectorAll("[data-capture-index]").forEach((button) => {
        button.onclick = () => {
          currentDraft = related[Number(button.dataset.captureIndex)];
          renderPreview();
        };
      });
      const save = query(root, "save");
      if (save) save.onclick = () => saveImages([currentDraft]);
      const open = query(root, "open");
      if (open) open.onclick = () => ctx.api.openExport(currentDraft.exportId).catch(ctx.failure);
      const saveAll = query(root, "save-all");
      if (saveAll) saveAll.onclick = () => saveImages(related.filter((item) => !item.saved));
      ctx.icons();
    }

    async function saveImages(items) {
      await execute(ctx, root, "Saving image files…", async () => {
        let count = 0;
        for (const item of items) {
          const entry = await ctx.api.saveScreenshot({ id: item.id });
          item.saved = true;
          item.exportId = entry?.id;
          count += 1;
        }
        ctx.notify(count === 1 ? "Screenshot exported." : `${count} screenshots exported.`, "success");
      }, { cancellable: false });
      if (root.isConnected) renderPreview();
      await refreshData(ctx);
    }

    function updateControls() {
      const values = read();
      query(root, "custom-dimensions").hidden = !values.devices.includes("custom");
      form.elements.width.disabled = !values.devices.includes("custom");
      form.elements.height.disabled = !values.devices.includes("custom");
      form.elements.quality.disabled = values.format !== "jpeg";
      const isLive = liveSession?.url === values.url && values.devices.includes(liveSession.device);
      manualNotice.innerHTML = liveSession ? `${isLive ? openedManualSession() : '<p class="muted">An interactive preview is open for a different viewport or URL.</p>'}${createButton("Close preview", "close-live", "x", "ghost")}` : "";
      const close = query(root, "close-live");
      if (close) close.onclick = async () => {
        try {
          await ctx.api.closeWebsitePreview(liveSession.id);
          liveSession = undefined;
          updateControls();
        } catch (error) {
          ctx.failure(error);
        }
      };
      ctx.icons();
    }

    function remember() {
      const last = settingsByView.get("screenshots") || options;
      const latest = read();
      settingsByView.set("screenshots", {
        ...last,
        ...latest,
        width: latest.width || last.width,
        height: latest.height || last.height,
        quality: latest.quality || last.quality
      });
    }

    watchProjectUrl(ctx, form);
    form.addEventListener("change", () => {
      remember();
      updateControls();
      renderPreview();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = read();
      if (data.devices.length === 0) {
        ctx.notify("Choose at least one device viewport.", "error");
        return;
      }

      await execute(ctx, root, "Opening website…", async (job) => {
        assertValid(form);
        for (const id of data.devices) {
          if (job.cancelled) break;
          const input = screenOptions(data, id);
          const result = await ctx.api.captureScreenshot(input);
          if (input.manualId) {
            await ctx.api.closeWebsitePreview(input.manualId);
            liveSession = undefined;
          }
          if (!result?.id) throw new Error("The browser returned no capture.");
          const draft = {
            ...result,
            projectId: data.projectId,
            url: data.url,
            device: id,
            label: data.fullPage ? `${devices.find((item) => item.id === id).name} full page` : devices.find((item) => item.id === id).name
          };
          screenshotDrafts.push(draft);
          if (screenshotDrafts.length > 14) screenshotDrafts.shift();
          currentDraft = draft;
          if (root.isConnected) renderPreview();
        }
      });
      if (root.isConnected) updateControls();
    });

    query(root, "live").onclick = async () => {
      const data = read();
      if (data.devices.length !== 1) {
        ctx.notify("Select one device to open an interactive preview.", "info");
        return;
      }

      await execute(ctx, root, "Opening interactive Chromium…", async () => {
        assertValid(form);
        if (liveSession) {
          await ctx.api.closeWebsitePreview(liveSession.id);
          liveSession = undefined;
        }
        const input = screenOptions(data, data.devices[0]);
        const result = await ctx.api.previewWebsite(input);
        liveSession = { id: result.id, url: data.url, device: data.devices[0] };
      });
      if (root.isConnected) updateControls();
    };
    updateControls();
    renderPreview();
  }

  const templates = [
    ["minimal-dark", "Minimal Dark", "#17181d", "#292b34", "desktop", "center"],
    ["minimal-light", "Minimal Light", "#f0f0ee", "#adabc6", "laptop", "center"],
    ["purple-gradient", "Purple Gradient", "#613bd0", "#181d50", "laptop-phone", "center"],
    ["premium-studio", "Premium Studio", "#202734", "#0c1119", "desktop", "center"],
    ["floating-devices", "Floating Devices", "#f2e9f7", "#c9d8ef", "laptop-phone", "left"],
    ["browser-showcase", "Browser Showcase", "#222939", "#11161e", "browser", "center"],
    ["editorial", "Editorial Presentation", "#e7dccc", "#bfa78f", "tablet", "left"],
    ["clean-portfolio", "Clean Portfolio", "#f3f5f4", "#dbe8e5", "desktop-mobile", "center"]
  ];

  const mockupDevices = [
    ["desktop", "Desktop monitor"],
    ["laptop", "Laptop"],
    ["smartphone", "Smartphone"],
    ["tablet", "Tablet"],
    ["browser", "Browser window"],
    ["laptop-phone", "Laptop and smartphone"],
    ["desktop-mobile", "Desktop and mobile"]
  ];

  const portfolioPresets = [
    ["fiverr", "Fiverr portfolio", 1280, 768],
    ["freelancer", "Freelancer portfolio", 1600, 1200],
    ["behance", "Behance presentation", 1400, 2000],
    ["github", "GitHub project presentation", 1280, 640],
    ["social", "Social media", 1080, 1080],
    ["custom", "Custom dimensions", 1920, 1080]
  ];

  function mockupSourceOptions(ctx, projectId, id, mobile = false) {
    const captures = screenshotDrafts.filter((item) => item.projectId === projectId).slice().reverse();
    const exports = ctx.state.history.filter((item) => (item.projectId || "") === projectId && ["screenshot", "screenshots"].includes(item.kind || item.type));
    return `<option value="">${mobile ? "Reuse primary screenshot" : "Choose a screenshot"}</option>
      ${captures.length ? `<optgroup label="Recent previews">${captures.map((item) => `<option value="${ctx.escape(item.id)}"${selected(id === item.id)}>${ctx.escape(item.label)} capture</option>`).join("")}</optgroup>` : ""}
      ${exports.length ? `<optgroup label="Saved exports">${exports.map((item) => `<option value="${ctx.escape(item.id)}"${selected(id === item.id)}>${ctx.escape(item.fileName || item.name || "Screenshot")}</option>`).join("")}</optgroup>` : ""}`;
  }

  function templatePicker(templateId) {
    return `<div class="template-grid">${templates.map(([id, label, base, edge]) => `
      <label class="template-option">
        <input type="radio" name="template" value="${id}"${checked(id === templateId)}>
        <span class="template-swatch" style="background:linear-gradient(135deg,${base},${edge})" aria-hidden="true">${icon("monitor")}</span>
        <span>${label}</span>
      </label>`).join("")}</div>`;
  }

  function artworkKey(mode, projectId) {
    return `${mode}:${projectId}`;
  }

  function studioTabs() {
    return `<div class="segmented" aria-label="Presentation type">
      <button type="button" class="button ${activeMockupTab === "mockup" ? "secondary" : "ghost"}" aria-pressed="${activeMockupTab === "mockup"}" data-role="mockup-tab">${icon("layers")} Mockup</button>
      <button type="button" class="button ${activeMockupTab === "portfolio" ? "secondary" : "ghost"}" aria-pressed="${activeMockupTab === "portfolio"}" data-role="portfolio-tab">${icon("layout-template")} Portfolio</button>
    </div>`;
  }

  function projectNarrative(project) {
    const features = Array.isArray(project.features) ? project.features : [project.features].filter(Boolean);
    const technologies = Array.isArray(project.technologies) ? project.technologies : [project.technologies].filter(Boolean);
    const parts = [
      project.name,
      [project.category, project.url].filter(Boolean).join(" · "),
      project.description,
      technologies.length ? `Technologies: ${technologies.join(", ")}` : "",
      features.length ? `Main features\n${features.map((feature) => `- ${feature}`).join("\n")}` : ""
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  function mockups(ctx, focusProject) {
    const mode = activeMockupTab;
    const settings = settingsByView.get(mode);
    const projectId = focusProject ?? defaultProject(ctx, settings);
    const project = projectById(ctx, projectId) || (mode === "portfolio" ? ctx.state.projects[0] : undefined);
    const subtitle = "Present website captures in original device frames and portfolio layouts.";
    if (!project && mode === "portfolio") {
      ctx.view.innerHTML = `${ctx.heading("Mockup Studio", subtitle, studioTabs())}
        <div class="panel">${previewPlaceholder("folder-plus", "Create a project first", "Add the website you want to present to your projects.")}
          <div class="actions">${createButton("Go to Projects", "projects", "folder", "primary")}</div>
        </div>`;
      query(ctx.view, "projects").onclick = () => ctx.go("projects");
      query(ctx.view, "mockup-tab").onclick = () => {
        activeMockupTab = "mockup";
        mockups(ctx);
      };
      ctx.icons();
      return;
    }

    const resolvedId = project?.id || "";
    const assetKey = artworkKey(mode, resolvedId);
    const assets = mockupAssets.get(assetKey) || {};
    const currentSettings = settingsByView.get(assetKey);
    const existingSource = screenshotDrafts.findLast((item) => item.projectId === resolvedId && item.device === "desktop") ||
      screenshotDrafts.findLast((item) => item.projectId === resolvedId);
    const existingExport = ctx.state.history.find((item) => (item.projectId || "") === resolvedId && (item.kind || item.type) === "screenshot");
    const options = {
      template: "minimal-dark",
      device: "desktop",
      width: 1920,
      height: 1080,
      dimensionPreset: "1080p",
      format: "png",
      quality: ctx.state.settings.imageQuality || 90,
      sourceId: existingSource?.id || existingExport?.id,
      customBackground: false,
      background: "#17181d",
      gradientEnabled: false,
      gradient: "#292b34",
      positionX: 0,
      positionY: 0,
      scale: 92,
      rotation: 0,
      perspective: 0,
      shadow: 55,
      radius: 18,
      padding: 44,
      title: project?.name || "",
      subtitle: project?.category || "",
      text: "",
      align: "center",
      preset: "behance",
      description: project ? projectNarrative(project) : "",
      ...(mode === "portfolio" ? { width: 1400, height: 2000 } : {}),
      ...currentSettings,
      projectId: resolvedId
    };

    const baseOptions = `<div class="form-grid">
      ${field("File type", select("format", options.format, [["png", "PNG"], ["jpeg", "JPEG"]]))}
      ${field("JPEG quality", number("quality", options.quality, 1, 100))}
      </div>`;

    function sourceControls() {
      return `${field("Primary screenshot", `<select name="sourceId">${mockupSourceOptions(ctx, resolvedId, options.sourceId)}</select>`)}
        <div class="actions">${project ? createButton("Capture website", "capture-source", "camera") : ""}
          ${createButton("Import image", "import-source", "image-plus")}</div>
        <span class="muted" data-role="source-label"></span>
        <div data-role="mobile-source">
          ${field("Mobile screenshot", `<select name="mobileSourceId">${mockupSourceOptions(ctx, resolvedId, options.mobileSourceId, true)}</select>`)}
          <div class="actions">${project ? createButton("Capture mobile", "capture-mobile", "smartphone") : ""}
            ${createButton("Import mobile image", "import-mobile", "image-plus")}</div>
          <span class="muted" data-role="mobile-label"></span>
        </div>`;
    }

    function mockupControls() {
      return `${group("Source images", sourceControls())}
        ${group("Template", templatePicker(options.template))}
        ${group("Device frame", `
          ${field("Device", select("device", options.device, mockupDevices))}
          <div class="form-grid">
            ${field("Position X (%)", number("positionX", options.positionX, -100, 100))}
            ${field("Position Y (%)", number("positionY", options.positionY, -100, 100))}
            ${field("Size (%)", number("scale", options.scale, 20, 180))}
            ${field("Rotation (°)", number("rotation", options.rotation, -45, 45))}
            ${field("Perspective (°)", number("perspective", options.perspective, -65, 65))}
            ${field("Shadow (%)", number("shadow", options.shadow, 0, 100))}
            ${field("Corner radius (px)", number("radius", options.radius, 0, 100))}
            ${field("Padding (px)", number("padding", options.padding, 0, 240))}
          </div>`)}
        ${group("Background", `
          ${checkbox("customBackground", "Customize background colors", options.customBackground)}
          <div data-role="background-colors">
            <div class="form-grid">
              ${field("Base color", `<input name="background" type="color" value="${ctx.escape(options.background)}">`)}
              ${field("Gradient color", `<input name="gradient" type="color" value="${ctx.escape(options.gradient)}">`)}
            </div>
            ${checkbox("gradientEnabled", "Use gradient", options.gradientEnabled)}
          </div>
          <div class="actions">${createButton("Import background", "import-background", "image-plus")}
            ${createButton("Remove", "remove-background", "x", "ghost")}</div>
          <span class="muted" data-role="background-label"></span>`)}
        ${group("Typography", `
          ${field("Project title", `<input name="title" maxlength="100" value="${ctx.escape(options.title)}">`)}
          ${field("Subtitle", `<input name="subtitle" maxlength="160" value="${ctx.escape(options.subtitle)}">`)}
          ${field("Custom text", `<textarea name="text" maxlength="500" rows="2">${ctx.escape(options.text)}</textarea>`)}
          ${field("Text alignment", select("align", options.align, [["left", "Left"], ["center", "Center"], ["right", "Right"]]))}`)}
        ${group("Export size", `
          ${field("Dimensions", select("dimensionPreset", options.dimensionPreset, [["1080p", "1080p · 1920 × 1080"], ["4k", "4K · 3840 × 2160"], ["custom", "Custom dimensions"]]))}
          ${dimensionFields(options.width, options.height, 320, 4096)}
          ${baseOptions}`)}`;
    }

    function portfolioControls() {
      return `${group("Presentation", `
        ${field("Platform preset", select("preset", options.preset, portfolioPresets.map(([id, name]) => [id, name])))}
        ${dimensionFields(options.width, options.height, 320, 4096)}
        ${baseOptions}`)}
        ${group("Editable description", `
        ${field("Text export", `<textarea name="description" maxlength="12000" rows="12">${ctx.escape(options.description)}</textarea>`)}
        <p class="muted">The export includes a presentation image, plain text, and project information.</p>`)}`;
    }

    ctx.view.innerHTML = `${ctx.heading("Mockup Studio", subtitle, studioTabs())}
      <div class="studio-grid" data-role="studio">
        <form class="panel studio-controls" data-role="form">
          ${group("Project", field("Website project", `<select name="projectId">${projectOptions(ctx, resolvedId, mode === "mockup" ? "Standalone mockup" : "")}</select>`))}
          ${mode === "mockup" ? mockupControls() : portfolioControls()}
          <div class="actions">
            <button type="submit" class="button primary">${icon(mode === "mockup" ? "layers" : "layout-template")}<span>${mode === "mockup" ? "Render preview" : "Generate portfolio"}</span></button>
          </div>
        </form>
        <section class="panel studio-preview" aria-label="Presentation preview">
          <div class="panel-heading preview-toolbar"><h2>${mode === "mockup" ? "Canvas" : "Portfolio preview"}</h2>
            <div class="actions">${createButton(mode === "mockup" ? "Export image" : "Export portfolio", "save", "download", "primary", true)}</div>
          </div>
          <div class="preview-stage" data-role="canvas"></div>
          <p class="muted" data-role="preview-error" role="status" hidden></p>
          ${jobStatus()}
        </section>
      </div>`;

    const root = query(ctx.view, "studio");
    const form = query(root, "form");
    const canvas = query(root, "canvas");
    const saveButton = query(root, "save");
    let timer;
    resumeProgress(ctx, root);

    function read() {
      const data = getFormValues(form);
      data.quality ??= options.quality;
      return data;
    }

    function requestOptions() {
      const data = read();
      if (mode === "portfolio") {
        const { description, ...presentation } = data;
        return presentation;
      }
      return {
        ...data,
        background: data.customBackground ? data.background : undefined,
        gradient: data.customBackground ? (data.gradientEnabled ? data.gradient : false) : undefined,
        sourceId: assets.source ? undefined : data.sourceId || undefined,
        imageAssetId: assets.source?.id,
        mobileSourceId: query(root, "mobile-source").hidden || assets.mobile ? undefined : data.mobileSourceId || undefined,
        mobileAssetId: query(root, "mobile-source").hidden ? undefined : assets.mobile?.id,
        backgroundAssetId: assets.background?.id
      };
    }

    function paint() {
      const draft = artworkDrafts.get(assetKey);
      canvas.innerHTML = imagePreview(ctx, draft, "Rendered presentation", previewPlaceholder(
        mode === "mockup" ? "layers" : "layout-template", "Your preview will appear here",
        mode === "mockup" ? "Choose or capture a website image to render your mockup." : "Generate a presentation with desktop, mobile, and device imagery."
      ));
      const fingerprint = JSON.stringify(requestOptions());
      saveButton.disabled = !draft?.id || draft.saved || draft.fingerprint !== fingerprint;
      ctx.icons();
    }

    function updateControls() {
      form.elements.quality.disabled = form.elements.format.value !== "jpeg";
      if (mode === "mockup") {
        const assetPlaceholder = (key) => assets[key]?.name ? `Imported: ${assets[key].name}` : "";
        query(root, "mobile-source").hidden = !["laptop-phone", "desktop-mobile"].includes(form.elements.device.value);
        query(root, "background-colors").hidden = !form.elements.customBackground.checked;
        form.elements.gradient.disabled = !form.elements.gradientEnabled.checked;
        query(root, "source-label").textContent = assetPlaceholder("source");
        query(root, "mobile-label").textContent = assetPlaceholder("mobile");
        query(root, "background-label").textContent = assetPlaceholder("background");
        query(root, "remove-background").hidden = !assets.background;
      }
    }

    function showPreviewError(message = "") {
      const output = query(root, "preview-error");
      output.hidden = !message;
      output.textContent = message;
    }

    function remember() {
      const values = read();
      settingsByView.set(mode, values);
      settingsByView.set(assetKey, values);
    }

    async function renderArtwork(quiet = false) {
      clearTimeout(timer);
      if (activeJob) {
        if (quiet) scheduleRender();
        else ctx.notify("A studio operation is already running.", "info");
        return;
      }
      const data = requestOptions();
      if (mode === "mockup" && !data.sourceId && !data.imageAssetId) {
        if (!quiet) ctx.notify("Select, import, or capture a primary screenshot first.", "info");
        return;
      }
      if (quiet && !form.checkValidity()) return;
      const fingerprint = JSON.stringify(data);
      if (quiet && artworkDrafts.get(assetKey)?.fingerprint === fingerprint) return;

      try {
        const result = await execute(ctx, root, mode === "mockup" ? "Rendering composition…" : "Preparing portfolio assets…", async () => {
          assertValid(form);
          showPreviewError();
          return mode === "mockup" ? ctx.api.renderMockup(data) : ctx.api.renderPortfolio(data);
        }, { quiet });
        if (result?.id) {
          artworkDrafts.set(assetKey, { ...result, fingerprint });
          if (root.isConnected) paint();
        }
      } catch (error) {
        if (root.isConnected) showPreviewError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
      }
    }

    function scheduleRender() {
      if (mode !== "mockup") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (root.isConnected) void renderArtwork(true);
      }, 500);
    }

    async function importAsset(key, sourceField) {
      try {
        const result = await ctx.api.pickImage();
        if (!result?.id) return;
        assets[key] = result;
        mockupAssets.set(assetKey, assets);
        if (sourceField) form.elements[sourceField].value = "";
        remember();
        updateControls();
        paint();
        scheduleRender();
      } catch (error) {
        ctx.failure(error);
      }
    }

    async function captureSource(deviceId, key, sourceField) {
      const preset = devices.find((item) => item.id === deviceId);
      const result = await execute(ctx, root, `Capturing ${preset.name.toLowerCase()} website…`, () => ctx.api.captureScreenshot({
        projectId: resolvedId,
        url: project.url,
        device: preset.id,
        width: preset.width,
        height: preset.height,
        format: "png",
        waitForAssets: true
      }));
      if (!result?.id) return;
      screenshotDrafts.push({ ...result, device: deviceId, label: preset.name, projectId: resolvedId, url: project.url });
      if (screenshotDrafts.length > 14) screenshotDrafts.shift();
      if (!root.isConnected) return;
      delete assets[key];
      form.elements[sourceField].innerHTML = mockupSourceOptions(ctx, resolvedId, result.id, key === "mobile");
      remember();
      updateControls();
      paint();
      scheduleRender();
    }

    saveButton.onclick = async () => {
      const draft = artworkDrafts.get(assetKey);
      if (!draft?.id || draft.fingerprint !== JSON.stringify(requestOptions())) return;
      await execute(ctx, root, "Writing exported files…", async () => {
        const entry = mode === "mockup" ? await ctx.api.saveMockup({ id: draft.id }) :
          await ctx.api.savePortfolio({ id: draft.id, description: form.elements.description.value });
        draft.saved = true;
        draft.exportId = entry?.id;
        ctx.notify(mode === "mockup" ? "Mockup exported." : "Portfolio exported.", "success");
      }, { cancellable: false });
      if (root.isConnected) paint();
      await refreshData(ctx);
    };

    query(ctx.view, "mockup-tab").onclick = () => {
      remember();
      activeMockupTab = "mockup";
      mockups(ctx, resolvedId);
    };
    query(ctx.view, "portfolio-tab").onclick = () => {
      remember();
      activeMockupTab = "portfolio";
      mockups(ctx, resolvedId);
    };

    if (mode === "mockup") {
      if (project) {
        query(root, "capture-source").onclick = () => captureSource("desktop", "source", "sourceId");
        query(root, "capture-mobile").onclick = () => captureSource("mobile", "mobile", "mobileSourceId");
      }
      query(root, "import-source").onclick = () => importAsset("source", "sourceId");
      query(root, "import-mobile").onclick = () => importAsset("mobile", "mobileSourceId");
      query(root, "import-background").onclick = () => importAsset("background");
      query(root, "remove-background").onclick = () => {
        delete assets.background;
        updateControls();
        paint();
        scheduleRender();
      };
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      remember();
      void renderArtwork();
    });
    form.addEventListener("change", (event) => {
      const { name, value } = event.target;
      if (name === "projectId") {
        ctx.state.selectedProjectId = value;
        mockups(ctx, value);
        return;
      }
      if (name === "sourceId" && value) delete assets.source;
      if (name === "mobileSourceId" && value) delete assets.mobile;
      if (name === "template") {
        const [, , background, gradient, device, align] = templates.find(([id]) => id === value);
        form.elements.device.value = device;
        form.elements.align.value = align;
        if (!form.elements.customBackground.checked) {
          form.elements.background.value = background;
          form.elements.gradient.value = gradient;
          form.elements.gradientEnabled.checked = !["minimal-dark", "minimal-light", "editorial"].includes(value);
        }
      }
      if (name === "dimensionPreset" && value !== "custom") {
        form.elements.width.value = value === "4k" ? 3840 : 1920;
        form.elements.height.value = value === "4k" ? 2160 : 1080;
      }
      if (name === "preset" && value !== "custom") {
        const [, , width, height] = portfolioPresets.find(([id]) => id === value);
        form.elements.width.value = width;
        form.elements.height.value = height;
      }
      if (name === "width" || name === "height") {
        if (form.elements.dimensionPreset) form.elements.dimensionPreset.value = "custom";
      }
      remember();
      updateControls();
      paint();
      scheduleRender();
    });
    form.addEventListener("input", (event) => {
      if (event.target.name === "description") return;
      saveButton.disabled = true;
      scheduleRender();
    });
    updateControls();
    paint();
    scheduleRender();
  }

  const videoSizes = [
    ["landscape", "Landscape · 1920 × 1080", 1920, 1080],
    ["portrait", "Portrait · 1080 × 1920", 1080, 1920],
    ["square", "Square · 1080 × 1080", 1080, 1080],
    ["custom", "Custom dimensions", 1920, 1080]
  ];

  function defaultVideoTitle(url) {
    try {
      const address = url.includes("://") ? url : `https://${url}`;
      return new URL(address).hostname;
    } catch {
      return "Website presentation";
    }
  }

  function videos(ctx) {
    const saved = settingsByView.get("videos");
    const projectId = defaultProject(ctx, saved);
    const project = projectById(ctx, projectId);
    const outputWidth = ctx.state.settings.videoWidth || 1920;
    const outputHeight = ctx.state.settings.videoHeight || 1080;
    const options = {
      device: "desktop",
      mode: "smooth",
      width: 1920,
      height: 1080,
      outputPreset: videoSizes.find(([, , width, height]) => width === outputWidth && height === outputHeight)?.[0] || "custom",
      outputWidth,
      outputHeight,
      quality: ctx.state.settings.videoQuality ?? 23,
      duration: 12,
      initialPause: 1,
      finalPause: 1,
      scrollSpeed: 250,
      title: "",
      titleScreen: false,
      fadeIn: true,
      fadeOut: true,
      ...saved,
      projectId,
      url: projectId === saved?.projectId ? saved.url : project?.url
    };
    const lastVideo = (id) => ctx.state.history.find((item) => (item.projectId || "") === id && (item.kind || item.type) === "video");
    let completed = lastVideo(projectId);

    ctx.view.innerHTML = `${ctx.heading("Video Studio", "Record website motion and export a presentation-ready MP4.")}
      <div class="studio-grid" data-role="studio">
        <form class="panel studio-controls" data-role="form">
          ${group("Website", websiteInput(ctx, projectId, options.url))}
          ${group("Recording", `
            ${field("Mode", select("mode", options.mode, [
              ["static", "Static recording"], ["smooth", "Smooth scrolling"], ["top-to-bottom", "Scroll to bottom"],
              ["down-up", "Scroll down and back up"], ["manual", "Manual interaction"]
            ]))}
            <p class="muted" data-role="manual-video" hidden>Chromium opens during recording so you can interact with the page.</p>
            ${field("Capture viewport", select("device", options.device, devices.map((item) => [item.id, item.name])))}
            <div data-role="custom-viewport">${dimensionFields(options.width, options.height, 160, 4096)}</div>
            <div class="form-grid">
              ${field("Duration (sec)", number("duration", options.duration, 1, 180, 0.5))}
              ${field("Scroll speed (px/sec)", number("scrollSpeed", options.scrollSpeed, 10, 6000))}
              ${field("Initial pause (sec)", number("initialPause", options.initialPause, 0, 30, 0.5))}
              ${field("Final pause (sec)", number("finalPause", options.finalPause, 0, 30, 0.5))}
            </div>`)}
          ${group("Presentation", `
            ${checkbox("titleScreen", "Add a title screen", options.titleScreen)}
            <div data-role="title-input">${field("Title", `<input name="title" maxlength="120" value="${ctx.escape(options.title)}" placeholder="Use project name">`)}</div>
            ${checkbox("fadeIn", "Fade in", options.fadeIn)}
            ${checkbox("fadeOut", "Fade out", options.fadeOut)}`)}
          ${group("MP4 export", `
            ${field("Format", select("outputPreset", options.outputPreset, videoSizes.map(([id, label]) => [id, label])))}
            ${dimensionFields(options.outputWidth, options.outputHeight, 160, 3840, "outputWidth", "outputHeight")}
            ${field("Quality (CRF)", number("quality", options.quality, 0, 51))}
            <p class="muted">Lower CRF keeps more detail and produces a larger MP4.</p>`)}
          <div class="actions"><button class="button primary" type="submit">${icon("video")}<span>Record and export</span></button></div>
        </form>
        <section class="panel studio-preview" aria-label="Video recording">
          <div class="panel-heading preview-toolbar"><h2>Recording output</h2><span class="badge">MP4 · H.264</span></div>
          <div class="preview-stage" data-role="canvas"></div>
          ${jobStatus()}
        </section>
      </div>`;

    const root = query(ctx.view, "studio");
    const form = query(root, "form");
    const canvas = query(root, "canvas");
    resumeProgress(ctx, root);
    watchProjectUrl(ctx, form);

    function paint() {
      canvas.innerHTML = completed?.id ? `<div class="empty-state"><div class="empty-icon">${icon("film")}</div>
        <h3>${ctx.escape(completed.fileName || completed.name || "Video export completed")}</h3>
        <p class="muted">Your recording is saved to the Videos folder.</p>
        <div class="actions">${createButton("Play video", "play", "play", "primary")}
          ${createButton("Open folder", "folder", "folder-open")}</div></div>` :
        previewPlaceholder("video", "Ready to record", "Choose a recording mode and export size, then start recording.");
      const play = query(root, "play");
      const folder = query(root, "folder");
      if (play) play.onclick = async () => {
        try {
          await ctx.api.openExport(completed.id);
        } catch (error) {
          ctx.failure(error);
        }
      };
      if (folder) folder.onclick = async () => {
        try {
          if (ctx.api.openExportFolder) await ctx.api.openExportFolder(completed.id);
          else if (completed.projectId) await ctx.api.openProjectFolder(completed.projectId);
        } catch (error) {
          ctx.failure(error);
        }
      };
      if (folder && !ctx.api.openExportFolder && !completed.projectId) folder.hidden = true;
      ctx.icons();
    }

    function updateControls() {
      const isCustom = form.elements.device.value === "custom";
      query(root, "custom-viewport").hidden = !isCustom;
      form.elements.width.disabled = !isCustom;
      form.elements.height.disabled = !isCustom;
      query(root, "manual-video").hidden = form.elements.mode.value !== "manual";
      form.elements.scrollSpeed.disabled = form.elements.mode.value !== "smooth";
      query(root, "title-input").hidden = !form.elements.titleScreen.checked;
      form.elements.title.disabled = !form.elements.titleScreen.checked;
    }

    function remember() {
      const last = settingsByView.get("videos") || options;
      settingsByView.set("videos", { ...last, ...getFormValues(form) });
    }

    form.addEventListener("change", (event) => {
      const { name, value } = event.target;
      if (name === "outputPreset" && value !== "custom") {
        const [, , width, height] = videoSizes.find(([id]) => id === value);
        form.elements.outputWidth.value = width;
        form.elements.outputHeight.value = height;
      }
      if (name === "outputWidth" || name === "outputHeight") form.elements.outputPreset.value = "custom";
      if (name === "projectId") {
        completed = lastVideo(value);
        paint();
      }
      remember();
      updateControls();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = getFormValues(form);
      const selectedProject = projectById(ctx, input.projectId);
      const preset = devices.find((item) => item.id === input.device);
      const data = {
        ...input,
        width: preset?.width || input.width,
        height: preset?.height || input.height,
        title: input.titleScreen ? input.title?.trim() || selectedProject?.name || defaultVideoTitle(input.url) : ""
      };
      remember();
      const result = await execute(ctx, root, data.mode === "manual" ? "Opening interactive Chromium…" : "Preparing recording…",
        () => ctx.api.recordVideo(data));
      if (!result?.id) return;
      completed = result;
      if (root.isConnected) paint();
      await refreshData(ctx);
      ctx.notify("Video exported.", "success");
    });

    updateControls();
    paint();
  }

  window.studios = { screenshots, mockups, videos };
})();
