const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const ffprobeStatic = require('ffprobe-static');
const ffmpegPath = require('ffmpeg-static');
const { spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXPORT_DIR = path.join(__dirname, 'exports');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

const NICHES = {
  travel: 'Journey arc with scenic payoff',
  wildlife: 'Action beats, habitat context, natural pacing',
  birding: 'Species moments, habitat detail, calm observational flow',
  documentary: 'Context before payoff',
  educational: 'Clear explain-first structure',
  lifestyle: 'Personal tone and relatable moments'
};

ensureDirectories();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const projectId = req.params.projectId || req.body.projectId;
    const projectDir = path.join(UPLOAD_DIR, projectId || 'temp');
    fs.mkdirSync(projectDir, { recursive: true });
    cb(null, projectDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({ storage: uploadStorage });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'Vlog app MVP is running' });
});

app.get('/api/projects', (_req, res) => {
  const projects = readProjects();
  res.json(projects);
});

app.get('/api/projects/:projectId', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const { title, niche, tone, targetRuntime, aspectRatio, resolution, audience } = req.body;

  const project = {
    id: uuidv4(),
    title: title || 'Untitled Vlog',
    niche: niche || 'travel',
    tone: tone || 'cinematic',
    targetRuntime: Number(targetRuntime) || 3,
    aspectRatio: aspectRatio || '16:9',
    resolution: resolution || '1080p',
    audience: audience || 'general',
    createdAt: new Date().toISOString(),
    media: [],
    storyboard: [],
    exportSummary: null
  };

  const projects = readProjects();
  projects.push(project);
  writeProjects(projects);

  res.status(201).json(project);
});

app.post('/api/projects/:projectId/media', upload.array('files', 50), async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const uploadedFiles = req.files || [];
  const imported = [];

  for (const file of uploadedFiles) {
    const metadata = await extractMediaMetadata(file.path);
    const type = detectMediaType(file.originalname);
    const highlight = type === 'video'
      ? analyzeVideoHighlight(file.path, metadata.duration)
      : { start: 0, score: 0 };
    const mediaItem = {
      id: uuidv4(),
      originalName: file.originalname,
      fileName: file.filename,
      storedPath: file.path,
      type,
      sizeBytes: file.size,
      duration: metadata.duration || 0,
      highlightStart: highlight.start,
      highlightScore: highlight.score,
      width: metadata.width || null,
      height: metadata.height || null,
      aspectRatio: metadata.aspectRatio || 'unknown',
      frameRate: metadata.frameRate || null,
      qualityScore: scoreClip({
        duration: metadata.duration || 0,
        width: metadata.width || 0,
        height: metadata.height || 0,
        type
      }),
      status: 'keep',
      notes: metadata.notes || 'Ready for review'
    };

    imported.push(mediaItem);
  }

  project.media.push(...imported);
  project.media.sort((a, b) => b.qualityScore - a.qualityScore);
  writeProjects(readProjects().map((item) => (item.id === project.id ? project : item)));

  res.json({ project, imported });
});

app.post('/api/projects/:projectId/generate-storyboard', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const candidateMedia = project.media.filter((item) => item.status !== 'reject');
  const sorted = [...candidateMedia].sort((a, b) =>
    (b.qualityScore + (b.highlightScore || 0) * 0.1) -
    (a.qualityScore + (a.highlightScore || 0) * 0.1)
  );

  const scenes = buildStoryboard(sorted, project.niche, project.targetRuntime);

  project.storyboard = scenes;
  project.exportSummary = buildExportSummary(project, scenes);
  writeProjects(readProjects().map((item) => (item.id === project.id ? project : item)));

  res.json({ project, storyboard: scenes });
});

app.patch('/api/projects/:projectId/media/:mediaId', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { status, notes } = req.body;
  const mediaItem = project.media.find((item) => item.id === req.params.mediaId);

  if (!mediaItem) {
    return res.status(404).json({ error: 'Media item not found' });
  }

  mediaItem.status = ['keep', 'reject', 'stabilize', 'trim'].includes(status) ? status : mediaItem.status;
  if (notes) mediaItem.notes = notes;

  writeProjects(readProjects().map((item) => (item.id === project.id ? project : item)));
  res.json({ project, mediaItem });
});

app.patch('/api/projects/:projectId/storyboard', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { storyboard } = req.body;
  if (!Array.isArray(storyboard)) {
    return res.status(400).json({ error: 'Storyboard payload must be an array' });
  }

  project.storyboard = storyboard.map((scene, index) => ({
    ...scene,
    sceneNumber: index + 1,
    duration: Number(scene.duration) || 0
  }));
  project.exportSummary = buildExportSummary(project, project.storyboard);

  writeProjects(readProjects().map((item) => (item.id === project.id ? project : item)));
  res.json({ project, storyboard: project.storyboard });
});

app.get('/api/projects/:projectId/export', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const exportPackage = buildExportSummary(project, project.storyboard || []);
  const exportDir = path.join(EXPORT_DIR, project.id);
  fs.mkdirSync(exportDir, { recursive: true });

  const jsonPath = path.join(exportDir, `${project.title.replace(/\s+/g, '_') || 'vlog'}-export.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(exportPackage, null, 2));

  const outputVideoPath = path.join(exportDir, `${project.title.replace(/\s+/g, '_') || 'vlog'}-export.mp4`);
  const createdVideo = generateProjectVideo(project, outputVideoPath);

  res.json({
    exportPackage,
    exportPath: jsonPath,
    videoPath: createdVideo ? outputVideoPath : null,
    videoCreated: Boolean(createdVideo),
    ffmpegAvailable: Boolean(ffmpegPath)
  });
});

app.get('/api/projects/:projectId/export-video', (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const exportDir = path.join(EXPORT_DIR, project.id);
  fs.mkdirSync(exportDir, { recursive: true });

  const outputVideoPath = path.join(exportDir, `${project.title.replace(/\s+/g, '_') || 'vlog'}-export.mp4`);
  const createdVideo = generateProjectVideo(project, outputVideoPath);

  if (!createdVideo || !fs.existsSync(outputVideoPath)) {
    return res.status(500).json({ error: 'Could not create export video' });
  }

  const safeFileName = `${(project.title || 'vlog').replace(/\s+/g, '_')}.mp4`;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
  res.download(outputVideoPath, safeFileName);
});

app.listen(PORT, () => {
  console.log(`Vlog app MVP running at http://localhost:${PORT}`);
});

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, '[]');
  }
}

function readProjects() {
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
}

function writeProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function getProjectById(projectId) {
  return readProjects().find((project) => project.id === projectId);
}

function detectMediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) return 'audio';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  return 'video';
}

function buildAspectRatio(width, height) {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.2) return '16:9';
  if (Math.abs(ratio - 9 / 16) < 0.2) return '9:16';
  if (Math.abs(ratio - 1) < 0.2) return '1:1';
  return `${width}:${height}`;
}

function scoreClip({ duration, width, height, type }) {
  let score = 60;
  if (type === 'video') score += 15;
  if (type === 'audio') score += 5;
  if (width && height) {
    const ratio = width / height;
    if (Math.abs(ratio - 16 / 9) < 0.2) score += 10;
    if (Math.abs(ratio - 9 / 16) < 0.2) score += 8;
  }
  if (duration > 5 && duration < 30) score += 10;
  if (duration > 30) score += 5;
  return score;
}

function analyzeVideoHighlight(filePath, duration) {
  const sourceDuration = Number(duration) || 0;
  const windowDuration = Math.min(6, sourceDuration);
  const centeredStart = Math.max(0, (sourceDuration - windowDuration) / 2);
  if (!ffmpegPath || sourceDuration <= 0) return { start: centeredStart, score: 0 };

  const result = spawnSync(ffmpegPath, [
    '-hide_banner',
    '-i', filePath,
    '-vf', 'fps=2,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=mode=print',
    '-an',
    '-f', 'null',
    '-'
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  if (result.error) return { start: centeredStart, score: 0 };

  const samples = [];
  let sample = null;
  for (const line of `${result.stdout || ''}\n${result.stderr || ''}`.split(/\r?\n/)) {
    const frameMatch = line.match(/pts_time:([\d.]+)/);
    if (frameMatch) sample = { time: Number(frameMatch[1]) };

    const motionMatch = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (motionMatch && sample) {
      sample.motion = Number(motionMatch[1]);
      samples.push(sample);
      sample = null;
    }
  }

  if (!samples.length) return { start: centeredStart, score: 0 };

  const latestStart = Math.max(0, sourceDuration - windowDuration);
  let best = { start: centeredStart, score: -1 };
  let firstSampleIndex = 0;
  let endSampleIndex = 0;
  let windowMotion = 0;
  for (let start = 0; start <= latestStart; start += 0.5) {
    while (firstSampleIndex < samples.length && samples[firstSampleIndex].time < start) {
      windowMotion -= samples[firstSampleIndex].motion;
      firstSampleIndex += 1;
    }
    endSampleIndex = Math.max(endSampleIndex, firstSampleIndex);
    while (endSampleIndex < samples.length && samples[endSampleIndex].time < start + windowDuration) {
      windowMotion += samples[endSampleIndex].motion;
      endSampleIndex += 1;
    }
    const sampleCount = endSampleIndex - firstSampleIndex;
    const score = sampleCount ? windowMotion / sampleCount : 0;
    const centeredDistance = Math.abs(start - centeredStart);
    const bestDistance = Math.abs(best.start - centeredStart);
    if (score > best.score || (score === best.score && centeredDistance < bestDistance)) {
      best = { start, score };
    }
  }

  return { start: Math.min(best.start, latestStart), score: best.score };
}

function buildStoryboard(media, niche, targetRuntime) {
  const narrative = NICHES[niche] || NICHES.travel;
  const strong = media.filter((item) => item.type !== 'audio').slice(0, 5);

  if (!strong.length) {
    return [{
      sceneNumber: 1,
      title: 'No usable footage found',
      reason: 'Add media to generate a storyboard.',
      clipId: null,
      duration: 0,
      summary: 'Upload more clips to start the story assembly.'
    }];
  }

  const scenes = [
    {
      sceneNumber: 1,
      title: 'Hook',
      reason: 'Open with the most visually striking clip to grab attention.',
      clipId: strong[0]?.id,
      duration: Math.max(6, Math.min(12, Math.round((targetRuntime || 3) * 0.18))),
      summary: narrative
    },
    {
      sceneNumber: 2,
      title: 'Context',
      reason: 'Set the place, subject, or situation before the main reveal.',
      clipId: strong[1]?.id || strong[0]?.id,
      duration: Math.max(8, Math.min(18, Math.round((targetRuntime || 3) * 0.22))),
      summary: 'Establish location, subject, and stakes.'
    },
    {
      sceneNumber: 3,
      title: 'Main Event',
      reason: 'Use the strongest dynamic or emotional moment as the centerpiece.',
      clipId: strong[2]?.id || strong[0]?.id,
      duration: Math.max(10, Math.min(22, Math.round((targetRuntime || 3) * 0.33))),
      summary: 'Deliver the heart of the story.'
    },
    {
      sceneNumber: 4,
      title: 'Payoff',
      reason: 'Show the visual or emotional payoff that resolves the story arc.',
      clipId: strong[3]?.id || strong[0]?.id,
      duration: Math.max(8, Math.min(16, Math.round((targetRuntime || 3) * 0.18))),
      summary: 'Resolve tension and reward the viewer.'
    },
    {
      sceneNumber: 5,
      title: 'Outro',
      reason: 'Close with a summary, takeaway, or call to action.',
      clipId: strong[4]?.id || strong[0]?.id,
      duration: Math.max(5, Math.min(12, Math.round((targetRuntime || 3) * 0.09))),
      summary: 'Leave the audience with a clear takeaway.'
    }
  ];

  return scenes.slice(0, strong.length).map((scene, index) => ({
    ...scene,
    clipId: strong[index].id,
    trimStart: strong[index].type === 'video' ? Number(strong[index].highlightStart) || 0 : 0,
    duration: Math.max(scene.duration || 3, (scene.title === 'Hook' ? 3 : 2))
  }));
}

function calculateDisplayDuration(mediaItem) {
  if (!mediaItem || !mediaItem.type) return 3;

  if (mediaItem.type === 'image') {
    const baseSeconds = 3;
    const qualityLift = mediaItem.qualityScore && mediaItem.qualityScore > 80 ? 1.5 : 0;
    return Math.min(6, Math.max(2.5, baseSeconds + qualityLift));
  }

  const naturalDuration = Number(mediaItem.duration) || 5;
  return Math.min(10, Math.max(3, naturalDuration * 0.75));
}

function buildExportSummary(project, storyboard) {
  const mediaCount = project.media.length;
  const title = `${project.niche.charAt(0).toUpperCase() + project.niche.slice(1)} vlog: ${project.title}`;
  const description = `A ${project.tone} ${project.niche} vlog built for ${project.audience} viewers. Runtime target: ${project.targetRuntime} minutes.`;
  const tags = [project.niche, project.tone, project.resolution, project.aspectRatio, project.audience, 'vlog'];

  return {
    projectId: project.id,
    projectTitle: project.title,
    suggestedTitle: title,
    description,
    tags,
    runtimeTargetMinutes: project.targetRuntime,
    sceneCount: storyboard.length,
    mediaCount,
    generatedAt: new Date().toISOString(),
    chapters: storyboard.map((scene) => ({
      title: scene.title,
      seconds: scene.duration,
      reason: scene.reason
    }))
  };
}

function generateProjectVideo(project, outputPath) {
  const allowed = project.media.filter((item) => item.status !== 'reject');
  const mediaById = new Map(allowed.map((item) => [item.id, item]));
  const storyboardScenes = (project.storyboard || [])
    .map((scene) => ({ scene, media: mediaById.get(scene.clipId) }))
    .filter(({ media }) => media && (media.type === 'video' || media.type === 'image'));
  const uniqueStoryboardScenesSeen = new Set();
  const uniqueStoryboardScenes = storyboardScenes.filter(({ scene }) => {
    if (!scene.clipId) return false;
    if (uniqueStoryboardScenesSeen.has(scene.clipId)) return false;
    uniqueStoryboardScenesSeen.add(scene.clipId);
    return true;
  });
  const selectedScenes = uniqueStoryboardScenes.length
    ? uniqueStoryboardScenes
    : allowed.filter((item) => item.type === 'video' || item.type === 'image')
      .slice(0, 6)
      .map((media) => ({ scene: {}, media }));

  if (!selectedScenes.length) {
    const titleText = project.title.replace(/"/g, '\\"');
    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=0x101828:s=1280x720:d=6',
      '-vf', `drawtext=text='${titleText}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    ];

    const result = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
    return result.status === 0 && fs.existsSync(outputPath);
  }

  const ffmpegArgs = ['-y'];
  const filters = [];
  const transformFiles = [];

  selectedScenes.forEach(({ scene, media: item }, index) => {
    const sceneDuration = Number(scene.duration) || calculateDisplayDuration(item);
    const displayDuration = item.type === 'image'
      ? Math.min(8, Math.max(2.5, Math.min(sceneDuration, calculateDisplayDuration(item))))
      : Math.min(calculateDisplayDuration(item), sceneDuration);

    if (item.type === 'image') {
      ffmpegArgs.push('-loop', '1', '-t', String(displayDuration), '-i', item.storedPath);
    } else {
      const fallbackStart = item.highlightStart === undefined
        ? analyzeVideoHighlight(item.storedPath, item.duration).start
        : Number(item.highlightStart) || 0;
      const requestedStart = Number(scene.trimStart ?? fallbackStart);
      const sourceDuration = Number(item.duration) || displayDuration;
      const trimStart = Math.max(0, Math.min(requestedStart, Math.max(0, sourceDuration - displayDuration)));
      const transformFileName = `${path.basename(outputPath, path.extname(outputPath))}-${index}.trf`;
      const detectResult = spawnSync(ffmpegPath, [
        '-y',
        '-ss', String(trimStart),
        '-t', String(displayDuration),
        '-i', item.storedPath,
        '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${transformFileName}`,
        '-an',
        '-f', 'null',
        '-'
      ], { cwd: path.dirname(outputPath), encoding: 'utf8' });
      if (detectResult.error || detectResult.status !== 0) {
        console.error('FFmpeg stabilization analysis failed:', detectResult.error || detectResult.stderr);
      }
      const hasTransform = detectResult.status === 0 && fs.existsSync(path.join(path.dirname(outputPath), transformFileName));
      if (hasTransform) transformFiles.push(path.join(path.dirname(outputPath), transformFileName));
      ffmpegArgs.push('-ss', String(trimStart), '-t', String(displayDuration), '-i', item.storedPath);

      const stabilization = hasTransform
        ? `vidstabtransform=input=${transformFileName}:smoothing=30:optzoom=2:crop=black,`
        : 'deshake=rx=32:ry=32:edge=mirror,';
      const fadeInOut = `fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0.5, displayDuration - 0.5)}:d=0.5`;
      filters.push(`[%d:v]${stabilization}fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.06:brightness=0.01:saturation=1.12:gamma=1.02,colorbalance=rs=0.02:gs=0:bs=-0.02:rm=0.01:bm=-0.01,${fadeInOut}[v${index}]`);
      return;
    }

    const fadeInOut = `fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0.5, displayDuration - 0.5)}:d=0.5`;
    filters.push(`[%d:v]fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.06:brightness=0.01:saturation=1.12:gamma=1.02,colorbalance=rs=0.02:gs=0:bs=-0.02:rm=0.01:bm=-0.01,${fadeInOut}[v${index}]`);
  });

  const filterString = filters.map((filter, index) => filter.replace('%d', String(index))).join(';');
  const concatInputs = selectedScenes.map((_, index) => `[v${index}]`).join('');

  ffmpegArgs.push(
    '-filter_complex', `${filterString};${concatInputs}concat=n=${selectedScenes.length}:v=1:a=0[v]`,
    '-map', '[v]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath
  );

  const result = spawnSync(ffmpegPath, ffmpegArgs, {
    cwd: path.dirname(outputPath),
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    console.error('FFmpeg video render failed:', result.error || result.stderr);
  }
  transformFiles.forEach((filePath) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  return result.status === 0 && fs.existsSync(outputPath);
}

async function extractMediaMetadata(filePath) {
  const mediaType = detectMediaType(filePath);

  if (mediaType !== 'video' && mediaType !== 'audio') {
    return {
      duration: 0,
      width: null,
      height: null,
      aspectRatio: 'unknown',
      frameRate: null,
      notes: 'Static asset ready for visual montage.'
    };
  }

  const probeArgs = [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height,avg_frame_rate,codec_name',
    '-of',
    'json',
    filePath
  ];

  const result = spawnSync(ffprobeStatic.path, probeArgs, { encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    return {
      duration: 0,
      width: null,
      height: null,
      aspectRatio: 'unknown',
      frameRate: null,
      notes: 'Metadata could not be extracted automatically.'
    };
  }

  try {
    const info = JSON.parse(result.stdout || '{}');
    const stream = info.streams && info.streams.find((item) => item.width || item.height);
    const duration = Number(info.format?.duration || 0);
    const width = stream?.width || null;
    const height = stream?.height || null;
    const frameRate = stream?.avg_frame_rate || null;

    return {
      duration,
      width,
      height,
      aspectRatio: buildAspectRatio(width, height),
      frameRate,
      notes: duration > 0 ? 'Strong footage candidate for storytelling.' : 'Media imported for review.'
    };
  } catch (error) {
    return {
      duration: 0,
      width: null,
      height: null,
      aspectRatio: 'unknown',
      frameRate: null,
      notes: 'Metadata parsing failed, but asset was uploaded.'
    };
  }
}
