/**
 * 知识图谱表现层的「可配置常量对象」。
 *
 * 设计方案明确要求（交付要求一节）：严禁把魔法数字散落在逻辑里，
 * 所有视觉/物理/交互参数必须集中在此，便于后期微调「手感」。
 *
 * 分组与设计方案一一对应：
 *   - node    → §2.1 节点
 *   - link    → §2.2 连线
 *   - label   → §2.3 文本标签 + §3.2 缩放阈值
 *   - physics → §4   物理引擎（多体斥力 / 弹簧 / 向心 / 碰撞）
 *   - interaction → §3 交互手感
 *   - background → §2.3 文字描边与画布背景色需一致
 */
export const GRAPH_CONFIG = {
  /** §2.1 节点 */
  node: {
    /** 基础半径 R（设计方案 4px） */
    baseRadius: 4,
    /** 动态缩放系数 k：Radius = baseRadius + sqrt(degree) * k */
    scaleFactor: 1.6,
    /** 默认节点颜色：暗黑模式强调色 */
    color: '#a882ff',
    /** 未创建 / 孤立 / 无权访问节点的颜色 */
    unresolvedColor: '#4d4d4d',
    /** 未创建节点的默认不透明度（低于默认节点） */
    unresolvedOpacity: 0.5,
    /** 悬停主节点的视觉放大倍率（§3.1） */
    hoverScale: 1.2,
    /** 悬停命中的吸附容差：在 radius 基础上外扩多少 px 都算命中（§3.1） */
    pickTolerance: 5,
  },

  /** §2.2 连线 */
  link: {
    /** 默认粗细（CSS 像素，会按 zoom 做逆补偿保证视觉恒定 1~1.5 px） */
    widthCss: 1.2,
    /** 悬停相关连线的粗细（§3.1 步骤 3） */
    hoverWidthCss: 2,
    /** 默认连线颜色：极其微弱的半透明白（§2.2） */
    color: 'rgba(255, 255, 255, 0.15)',
    /** 悬停相关连线的高亮颜色 */
    hoverColor: 'rgba(255, 255, 255, 0.9)',
  },

  /** §2.3 文本标签 + §3.2 文本显示阈值 */
  label: {
    /** 字体（系统默认无衬线） */
    font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    /** 字号（CSS 像素，会按 zoom 做逆补偿） */
    sizeCss: 12,
    /** 字体颜色 */
    color: '#cccccc',
    /** 悬停时文字颜色（§3.1 强制高亮色） */
    hoverColor: '#ffffff',
    /** 文字描边颜色：与画布背景完全一致（§2.3） */
    strokeColor: '#1e1e1e',
    /** 文字描边宽度（CSS 像素） */
    strokeWidth: 3,
    /** 标签相对节点边缘的垂直偏移（§2.3 「距离节点边缘 4px」） */
    offsetY: 4,
    /**
     * §3.2 文本显示阈值 —— 三段式：
     *   zoom < minZoomHideAll                → 隐藏所有非悬停标签
     *   minZoomHideAll ≤ zoom < minZoomShowTopDegree
     *                                        → 只有度数最高的前 topDegreeRatio 比例节点显示
     *   minZoomShowTopDegree ≤ zoom < minZoomShowAll
     *                                        → 度数较高的节点显示，其余继续隐藏（线性过渡）
     *   zoom ≥ minZoomShowAll                → 显示全部
     */
    minZoomHideAll: 0.35,
    minZoomShowTopDegree: 0.6,
    minZoomShowAll: 1.2,
    /** 「度数最高」前多少比例节点在 minZoomShowTopDegree 档开始显示 */
    topDegreeRatio: 0.15,
  },

  /** 画布背景色：必须与 label.strokeColor 一致（§2.3） */
  background: '#1e1e1e',

  /** §4 物理引擎 */
  physics: {
    /** 多体排斥力基础强度（负值 = 排斥） */
    chargeStrength: -120,
    /**
     * 排斥力按节点半径额外加成：strength = chargeStrength * (1 + radius * chargeRadiusBoost)
     * 保证大节点排斥力更强（§4.1 特性）
     */
    chargeRadiusBoost: 0.06,
    /** 弹簧基础距离（§4.2 30~50 px） */
    linkDistance: 40,
    /** 弹簧强度 */
    linkStrength: 0.6,
    /** 向心力强度（§4.3 极微弱） */
    centerStrength: 0.02,
    /** 碰撞半径 padding（§4.4 R + 2px） */
    collisionPadding: 2,
    /** 速度衰减（阻尼） */
    velocityDecay: 0.4,
    /** 能量每 tick 衰减系数（越大越快静止） */
    alphaDecay: 0.025,
    /** 能量下限：低于此值时 simulation 自动停止 */
    alphaMin: 0.002,
    /** 拖拽时注入的目标 alpha，用于「交互唤醒」（§4 模拟生命周期） */
    alphaReheatOnDrag: 0.4,
    /** 初次装载时的起始 alpha（§4 「极高的能量」） */
    alphaInit: 1,
  },

  /** §3 交互 */
  interaction: {
    /** 缩放下限（鸟瞰） */
    zoomMin: 0.15,
    /** 缩放上限（细看） */
    zoomMax: 6,
    /** 滚轮敏感度：zoom *= exp(-wheelDeltaY * zoomSpeed) */
    zoomSpeed: 0.0015,
    /** 悬停高亮/暗化的过渡时长（§3.1 150~200 ms） */
    hoverTransitionMs: 180,
    /** §3.1 全局暗化透明度 */
    dimOpacity: 0.1,
    /** 平移松手后的惯性衰减系数（每帧乘以该值） */
    panInertiaDecay: 0.92,
    /** 惯性速度低于此阈值就停止（px/frame） */
    panInertiaMinSpeed: 0.05,
    /** 被搜索过滤掉的节点的额外暗化透明度（区别于全局暗化） */
    queryDimOpacity: 0.15,
  },
} as const;

export type GraphConfig = typeof GRAPH_CONFIG;
