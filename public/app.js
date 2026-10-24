const projectForm = document.getElementById('projectForm');
const projectSelect = document.getElementById('projectSelect');
const projectOverview = document.getElementById('projectOverview');
const uploadBtn = document.getElementById('uploadBtn');
const generateBtn = document.getElementById('generateBtn');
const exportBtn = document.getElementById('exportBtn');
const mediaUpload = document.getElementById('mediaUpload');
const healthStatus = document.getElementById('healthStatus');
const loaderOverlay = document.getElementById('loaderOverlay');
const loaderText = document.getElementById('loaderText');

let selectedProjectId = null;
let currentProject = null;

function setLoading(isLoading, text = 'Working…') {
  if (!loaderOverlay || !loaderText) return;
  loaderOverlay.classList.toggle('hidden', !isLoading);
  loaderText.textContent = text;
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    healthStatus.textContent = data.ok ? 'Service online' : 'Service unavailable';
    healthStatus.style.color = data.ok ? '#57d6a8' : '#ff7c7c';
  } catch (error) {
    healthStatus.textContent = 'Service unavailable';
    healthStatus.style.color = '#ff7c7c';
  }
}

async function fetchProjects() {
  const response = await fetch('/api/projects');
  return response.json();
}

function renderProjectOptions(projects) {
  projectSelect.innerHTML = '<option value="">Select a project</option>' +
    projects.map((project) => `<option value="${project.id}">${project.title}</option>`).join('');

  if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
    projectSelect.value = selectedProjectId;
  }
}

async function loadProjects() {
  const projects = await fetchProjects();
  renderProjectOptions(projects);

  if (!projects.length) {
    projectOverview.className = 'project-overview empty-state';
    projectOverview.textContent = 'No projects yet. Create one to begin the workflow.';
    return;
  }

  const usedProject = projects.find((project) => project.id === selectedProjectId) || projects[0];
  selectedProjectId = usedProject.id;
  projectSelect.value = usedProject.id;
  renderProjectDetails(usedProject);
}

async function createProject(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());

  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const project = await response.json();
  selectedProjectId = project.id;
  await loadProjects();
  projectForm.reset();
}

async function uploadMedia() {
  if (!selectedProjectId) {
    alert('Please create a project first.');
    return;
  }

  const files = mediaUpload.files;
  if (!files.length) {
    alert('Choose one or more files to upload.');
    return;
  }

  setLoading(true, 'Uploading media…');

  try {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('files', file));

    const response = await fetch(`/api/projects/${selectedProjectId}/media`, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();
    if (!response.ok) {
      alert(result.error || 'Upload failed');
      return;
    }

    mediaUpload.value = '';
    await loadProjects();
    const project = await getProjectById(selectedProjectId);
    renderProjectDetails(project);
  } finally {
    setLoading(false);
  }
}

async function generateStoryboard() {
  if (!selectedProjectId) {
    alert('Select a project first.');
    return;
  }

  setLoading(true, 'Generating storyboard…');

  try {
    const response = await fetch(`/api/projects/${selectedProjectId}/generate-storyboard`, {
      method: 'POST'
    });

    const result = await response.json();
    if (!response.ok) {
      alert(result.error || 'Could not generate storyboard');
      return;
    }

    await loadProjects();
    renderProjectDetails(result.project);
  } finally {
    setLoading(false);
  }
}

async function exportProjectVideo() {
  if (!selectedProjectId) {
    alert('Select a project first.');
    return;
  }

  try {
    if (!window.showSaveFilePicker) {
      alert('Your browser does not support choosing a save location here. Open this app in Microsoft Edge or Google Chrome to save the export to a chosen location.');
      return;
    }

    const projectTitle = currentProject?.id === selectedProjectId ? currentProject.title : 'vlog';
    const safeName = `${(projectTitle || 'vlog').replace(/\s+/g, '_')}.mp4`;
    const fileHandle = await window.showSaveFilePicker({
      suggestedName: safeName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }]
    });

    setLoading(true, 'Rendering video…');
    const response = await fetch(`/api/projects/${selectedProjectId}/export-video`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Could not export video.');
    }

    const writable = await fileHandle.createWritable();
    await response.body.pipeTo(writable);
    alert('Video saved successfully.');
  } catch (error) {
    if (error.name !== 'AbortError') {
      alert(error.message || 'Could not export video.');
    }
  } finally {
    setLoading(false);
  }
}

async function getProjectById(projectId) {
  const response = await fetch(`/api/projects/${projectId}`);
  return response.json();
}

function renderProjectDetails(project) {
  if (!project) {
    projectOverview.className = 'project-overview empty-state';
    projectOverview.textContent = 'No project selected.';
    currentProject = null;
    return;
  }

  currentProject = project;
  const media = project.media || [];
  const mediaById = new Map(media.map((item) => [item.id, item]));
  const storyboard = project.storyboard || [];
  const exportSummary = project.exportSummary;

  projectOverview.className = 'project-overview';
  projectOverview.innerHTML = `
    <div class="project-card">
      <h3>${project.title}</h3>
      <div class="meta-grid">
        <div class="meta-box"><strong>Niche</strong><br>${project.niche}</div>
        <div class="meta-box"><strong>Tone</strong><br>${project.tone}</div>
        <div class="meta-box"><strong>Runtime</strong><br>${project.targetRuntime} min</div>
        <div class="meta-box"><strong>Format</strong><br>${project.aspectRatio} / ${project.resolution}</div>
      </div>
      <div>
        <span class="badge">${project.audience}</span>
        <span class="badge">${media.length} media files</span>
      </div>
    </div>

    <div class="project-card">
      <h3>Media review</h3>
      <div class="media-list">
        ${media.length ? media.map((item) => `
          <div class="media-item">
            <strong>${item.originalName}</strong>
            <div><span class="badge">${item.type}</span><span class="score">Score ${item.qualityScore}</span></div>
            <div>${item.aspectRatio || 'unknown'} • ${(item.duration || 0).toFixed(1)}s • ${item.status}</div>
            ${item.type === 'video' ? `<div>Selected highlight starts at ${(Number(item.highlightStart) || 0).toFixed(1)}s</div>` : ''}
            <div>${item.notes}</div>
            <label>
              Decision
              <select class="inline-select" data-media-status="${item.id}">
                <option value="keep" ${item.status === 'keep' ? 'selected' : ''}>Keep</option>
                <option value="reject" ${item.status === 'reject' ? 'selected' : ''}>Reject</option>
                <option value="stabilize" ${item.status === 'stabilize' ? 'selected' : ''}>Stabilize</option>
                <option value="trim" ${item.status === 'trim' ? 'selected' : ''}>Trim</option>
              </select>
            </label>
          </div>
        `).join('') : '<div class="empty-state">No media uploaded yet.</div>'}
      </div>
    </div>

    <div class="project-card">
      <h3>Storyboard</h3>
      <div class="story-list">
        ${storyboard.length ? storyboard.map((scene, index) => `
          <div class="story-item" data-scene-index="${index}">
            <strong>Scene ${scene.sceneNumber}: ${scene.title}</strong>
            <div>${scene.reason}</div>
            <div>${scene.duration}s${mediaById.get(scene.clipId)?.type === 'video' ? ` • from ${(Number(scene.trimStart) || 0).toFixed(1)}s` : ''}</div>
            <div class="story-actions">
              <button type="button" class="mini-btn" data-scene-action="up">↑ Up</button>
              <button type="button" class="mini-btn" data-scene-action="down">↓ Down</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state">No storyboard generated yet.</div>'}
      </div>
    </div>

    ${exportSummary ? `
      <div class="project-card export-box">
        <h3>Export summary</h3>
        <div><strong>Suggested title:</strong> ${exportSummary.suggestedTitle}</div>
        <div><strong>Description:</strong> ${exportSummary.description}</div>
        <div><strong>Tags:</strong> ${exportSummary.tags.join(', ')}</div>
        <div><strong>Scenes:</strong> ${exportSummary.sceneCount}</div>
      </div>
    ` : ''}
  `;
}

async function updateMediaStatus(mediaId, status) {
  if (!selectedProjectId) return;

  const response = await fetch(`/api/projects/${selectedProjectId}/media/${mediaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    alert('Could not update media status');
    return;
  }

  const project = await getProjectById(selectedProjectId);
  renderProjectDetails(project);
}

async function moveStoryboardScene(event, direction) {
  if (!currentProject || !currentProject.storyboard?.length) return;

  const sceneIndex = Number(event.target.closest('.story-item')?.dataset.sceneIndex);
  const storyboard = [...currentProject.storyboard];
  const newIndex = direction === 'up' ? sceneIndex - 1 : sceneIndex + 1;

  if (Number.isNaN(sceneIndex) || newIndex < 0 || newIndex >= storyboard.length) return;

  const [moved] = storyboard.splice(sceneIndex, 1);
  storyboard.splice(newIndex, 0, moved);

  const response = await fetch(`/api/projects/${selectedProjectId}/storyboard`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storyboard })
  });

  if (!response.ok) {
    alert('Could not update storyboard order');
    return;
  }

  const updatedProject = await getProjectById(selectedProjectId);
  renderProjectDetails(updatedProject);
}

projectOverview.addEventListener('change', async (event) => {
  const mediaId = event.target.dataset.mediaStatus;
  if (!mediaId) return;
  await updateMediaStatus(mediaId, event.target.value);
});

projectOverview.addEventListener('click', async (event) => {
  const action = event.target.dataset.sceneAction;
  if (!action) return;
  if (action === 'up' || action === 'down') {
    moveStoryboardScene(event, action);
  }
});

projectForm.addEventListener('submit', createProject);
projectSelect.addEventListener('change', async (event) => {
  selectedProjectId = event.target.value || null;
  if (!selectedProjectId) {
    projectOverview.className = 'project-overview empty-state';
    projectOverview.textContent = 'Select a project to begin.';
    currentProject = null;
    return;
  }

  const project = await getProjectById(selectedProjectId);
  renderProjectDetails(project);
});

uploadBtn.addEventListener('click', uploadMedia);
generateBtn.addEventListener('click', generateStoryboard);
exportBtn.addEventListener('click', exportProjectVideo);

checkHealth();
loadProjects();
