// Examples gallery — curated seed prompts that showcase what render_ui +
// sendUserMessage can do when the model uses them well. Each card's Try
// button stashes the prompt via setPendingPrompt(project, ...) and lands
// on /w/<project>, where Workspace's auto-draft picks the seed up and
// Session's isNew branch auto-sends it.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Workspace } from '@macaron/shared';
import { setPendingPrompt } from '../lib/newSession';

type Example = {
  id: string;
  emoji: string;
  title: string;
  blurb: string;
  category: 'interactive' | 'preview' | 'data';
  prompt: string;
};

const EXAMPLES: Example[] = [
  // ---- Interactive (asks the user something → click to answer) ----
  {
    id: 'framework-picker',
    emoji: '🧭',
    title: 'Pick a framework',
    blurb: 'A/B/C decision as clickable cards — no typing back.',
    category: 'interactive',
    prompt:
      '我想新起一个 web 项目，帮我在 Next.js / Vite+React / Remix / Astro 里选一个。' +
      '用 render_ui 画一张对比卡：每个候选一列，标出各自的适用场景 (SSR/SPA/静态站)、' +
      '生态活跃度、上手曲线、部署便利度。底部四个 Button，点击后调 sendUserMessage 告诉' +
      '我 "用 <XX> 起项目"，把上下文（我说的"新 web 项目"）也带上。',
  },
  {
    id: 'config-wizard',
    emoji: '⚙️',
    title: 'Service config wizard',
    blurb: 'Structured form → posts a JSON payload back.',
    category: 'interactive',
    prompt:
      '帮我设计一份新服务的初始配置。用 render_ui 画一个表单卡片，字段：服务名 (Input)、' +
      '端口 (Input number, 默认 8080)、Node 版本 (Select: 18/20/22)、是否启用 SSL (Switch)、' +
      '日志级别 (RadioGroup: debug/info/warn/error)、并发上限 (Slider 1-200)。' +
      '提交按钮 onClick 用 sendUserMessage 把所有字段汇总成一句话 + 附一个 JSON fenced ' +
      '块，让下一轮我可以直接读结构化数据。',
  },
  {
    id: 'destructive-confirm',
    emoji: '⚠️',
    title: 'Destructive confirm',
    blurb: 'Diff summary + Apply / Cancel buttons.',
    category: 'interactive',
    prompt:
      '假设我让你清理项目里所有 node_modules 目录。请不要真的执行，只做演示：' +
      '用 render_ui 画一张确认卡，标题红色警告风，中间列出"将要删除的 12 个候选路径"' +
      '（编一些常见的），底部一个灰色 Cancel + 一个 destructive 红色 "Delete 12 folders"，' +
      '点击后分别 sendUserMessage 说 "cancel" 或 "confirmed, do it"。',
  },

  // ---- UI Change Previews (ui-preview skill in action) ----
  {
    id: 'redesign-statusbar',
    emoji: '🎨',
    title: 'Redesign StatusBar',
    blurb: 'Read source → preview redesign → Apply writes files.',
    category: 'preview',
    prompt:
      '读 web/src/components/StatusBar.tsx 的当前实现，然后按 ui-preview skill：' +
      'render_ui 一份"改造后的 StatusBar" 完整预览 (更紧凑、状态圆点带渐变、字号统一，' +
      '把上下文用量和权限模式做成两个小 badge 而不是纯文字)，' +
      '底部三个按钮 Apply / Tweak / Discard。等我点 Apply 你才动文件。',
  },
  {
    id: 'copy-variants',
    emoji: '✍️',
    title: 'Landing copy A/B/C',
    blurb: 'Three hero variants side-by-side; click your favorite.',
    category: 'preview',
    prompt:
      '给一个假设的 AI 编程 IDE 产品写 hero 文案。用 render_ui 画一张 3-column 卡片，' +
      '每列一版风格不同的 headline + subline：(1) 极简直接，(2) 情感化，(3) 技术圈内味儿。' +
      '每列下面一个 "Use this" 按钮，点击 sendUserMessage 说 "选风格 X (原文)"，' +
      '这样下一轮可以基于选中的风格继续迭代或落地到 landing 组件。',
  },
  {
    id: 'dark-mode-preview',
    emoji: '🌙',
    title: 'Dark mode preview',
    blurb: 'Toggle-driven color scheme preview with Apply.',
    category: 'preview',
    prompt:
      '读 web/src/views/Home.tsx，用 render_ui 做一个"暗色模式预览"卡片：' +
      '上方是页面主视觉的迷你 mock (logo + 输入框 + 按钮 + 一段文字)，' +
      '底下一个 Switch "Dark mode"，切换时用 useState 让 mock 里的颜色实时改变。' +
      '最下方 Apply / Discard 按钮，Apply 用 sendUserMessage 说 "apply this dark palette ' +
      'to the Home page for real"。别真的改文件，等我看完 preview 才动。',
  },

  // ---- Data & status ----
  {
    id: 'csv-visualize',
    emoji: '📊',
    title: 'Visualize this CSV',
    blurb: 'Paste tabular data, get a chart + summary.',
    category: 'data',
    prompt:
      '编 168 行"过去 7 天 API 每小时请求量"的示例数据 (工作日高峰 + 周末低谷 + 一次尖刺)。' +
      '用 render_ui 渲染一张仪表盘：顶部 4 个 Stat (总量 / 峰值 / 均值 / 峰谷比)，' +
      '下方 LineChart 时间序列，右侧 PieChart 按 endpoint 分布，底部一句 AI 归纳的"洞察"。' +
      '用 macaron-ui 的 Chart 组件。',
  },
  {
    id: 'git-summary',
    emoji: '📅',
    title: '本周开发汇总',
    blurb: 'git log → dashboard: commits, files, contributors.',
    category: 'data',
    prompt:
      '用 Bash 跑 `git log --since="7 days ago" --pretty=format:"%h|%an|%ad|%s" --date=short ' +
      '--shortstat` 拿到本仓库最近 7 天提交，然后 render_ui 一张周报卡片：顶部 Stat 网格' +
      ' (commits / files changed / lines +/-/ contributors 数)，下面 Timeline 按天列出' +
      '主要 commit，最右边 PillRow 展示 top contributors。' +
      '底部一个按钮 "写成 Markdown 周报"，点击 sendUserMessage 让下一轮把它整理成' +
      'markdown 落地到 docs/weekly-2026-Wxx.md。',
  },
  {
    id: 'file-explorer',
    emoji: '🗂',
    title: 'Project file map',
    blurb: 'Read the workspace tree into a visual explorer.',
    category: 'data',
    prompt:
      '用 Bash 跑 `find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" ' +
      '-not -path "*/dist/*" | head -200` 拿一个文件清单。' +
      '按扩展名分组 (.tsx / .ts / .css / .md / .json / 其它)，用 render_ui 画一张 ' +
      'StatGrid：每种类型一个 tile，显示文件数 + 总代码行数 (用 wc -l 抽样估计即可)。' +
      '下面 Table 列出 top 10 最大的文件 (按行数)，每行一个"查看"按钮 sendUserMessage ' +
      '说 "打开 <file>"，方便我下一步 focus。',
  },
];

const CATEGORY_LABEL: Record<Example['category'], string> = {
  interactive: 'Interactive (buttons / forms / picker)',
  preview: 'UI change previews',
  data: 'Data & status',
};

export function Examples() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [target, setTarget] = useState<string>('');
  const navigate = useNavigate();

  useEffect(() => {
    api.workspaces().then((r) => {
      setWorkspaces(r.workspaces);
      if (r.workspaces.length > 0 && !target) setTarget(r.workspaces[0]!.project);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runExample = (ex: Example) => {
    if (!target) return;
    setPendingPrompt(target, ex.prompt);
    navigate(`/w/${encodeURIComponent(target)}`);
  };

  const grouped = groupBy(EXAMPLES, (e) => e.category);

  return (
    <div className="examples-view">
      <div className="examples-head">
        <div>
          <h1 className="examples-title">Examples</h1>
          <p className="examples-sub">
            Curated prompts that show what <code>render_ui</code> + <code>sendUserMessage</code> can do
            when Macaron uses them well. Pick a workspace, click Try — a new session opens with the
            prompt seeded and the model responds with a live widget you can click / fill / submit.
          </p>
        </div>
        <label className="examples-target">
          <span>Run in</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {workspaces.length === 0 && <option value="">No workspaces yet</option>}
            {workspaces.map((w) => (
              <option key={w.project} value={w.project}>{w.name}</option>
            ))}
          </select>
        </label>
      </div>

      {(['interactive', 'preview', 'data'] as const).map((cat) => {
        const items = grouped.get(cat) ?? [];
        if (items.length === 0) return null;
        return (
          <section className="examples-section" key={cat}>
            <h2 className="examples-section-title">{CATEGORY_LABEL[cat]}</h2>
            <div className="examples-grid">
              {items.map((ex) => (
                <article className="example-card" key={ex.id}>
                  <div className="example-card-emoji">{ex.emoji}</div>
                  <div className="example-card-body">
                    <h3 className="example-card-title">{ex.title}</h3>
                    <p className="example-card-blurb">{ex.blurb}</p>
                    <details className="example-card-details">
                      <summary>Show prompt</summary>
                      <pre>{ex.prompt}</pre>
                    </details>
                  </div>
                  <button
                    className="example-card-try"
                    onClick={() => runExample(ex)}
                    disabled={!target}
                    title={target ? `Try in ${target}` : 'Pick a workspace first'}
                  >
                    Try →
                  </button>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const t of arr) {
    const k = key(t);
    const bucket = m.get(k);
    if (bucket) bucket.push(t);
    else m.set(k, [t]);
  }
  return m;
}
