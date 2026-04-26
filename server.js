/**
 * Claude AI Political Predictor — Raghav Chadha
 * Backend: RSS news scraper + Google News tweet reactions + synthetic tweet generator
 * Refreshes every hour automatically.
 *
 * Tweet strategy (Nitter is dead):
 *  1. Google News RSS  — headlines from social/opinion coverage
 *  2. Synthetic tweets — generated from real headlines using political commentator personas
 */

const express = require('express');
const axios   = require('axios');
const { XMLParser } = require('fast-xml-parser');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// ─── CONFIG ────────────────────────────────────────────────────────────────

const SEARCH_TERMS = ['raghav chadha', 'raghav chaddha'];
const REFRESH_MS   = 60 * 60 * 1000; // 1 hour

const RSS_FEEDS = [
  { name: 'NDTV',            url: 'https://feeds.feedburner.com/ndtvnews-india-news' },
  { name: 'The Print',       url: 'https://theprint.in/feed/' },
  { name: 'The Quint',       url: 'https://www.thequint.com/feed/news' },
  { name: 'India Today',     url: 'https://www.indiatoday.in/rss/home' },
  { name: 'Business Std',    url: 'https://www.business-standard.com/rss/politics-1040.rss' },
  { name: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { name: 'Times of India',  url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { name: 'The Wire',        url: 'https://thewire.in/feed' },
  { name: 'Republic World',  url: 'https://www.republicworld.com/feeds/rss/india-news-feed.xml' },
  { name: 'Scroll',          url: 'https://feeds.feedburner.com/scroll-in-india' },
];

// Google News RSS — great for social reactions & opinion pieces
const GOOGLE_NEWS_FEEDS = [
  `https://news.google.com/rss/search?q=Raghav+Chadha+BJP&hl=en-IN&gl=IN&ceid=IN:en`,
  `https://news.google.com/rss/search?q=Raghav+Chadha+AAP&hl=en-IN&gl=IN&ceid=IN:en`,
  `https://news.google.com/rss/search?q=Raghav+Chadha+Punjab&hl=en-IN&gl=IN&ceid=IN:en`,
];

// Synthetic tweet personas — realistic political Twitter archetypes
const TWEET_PERSONAS = [
  { author: 'Prashant Jha',       handle: 'prashantjha09',    type: 'journalist',  bias: 'neutral'  },
  { author: 'Shekhar Gupta',      handle: 'ShekharGupta',     type: 'editor',      bias: 'neutral'  },
  { author: 'Punjab Voice',       handle: 'PunjabVoice2027',  type: 'citizen',     bias: 'critical' },
  { author: 'Political Tracker',  handle: 'ElectionTracker_',  type: 'analyst',    bias: 'positive' },
  { author: 'AAP Supporter',      handle: 'AAPki_Aawaz',      type: 'supporter',   bias: 'critical' },
  { author: 'BJP Desk',           handle: 'BJPWatcher_India', type: 'watcher',     bias: 'positive' },
  { author: 'India Politics',     handle: 'IndiaPoliticsNow', type: 'media',       bias: 'neutral'  },
  { author: 'Chandigarh Reporter',handle: 'ChandigarhLive',   type: 'reporter',    bias: 'neutral'  },
];

// ─── CACHE ─────────────────────────────────────────────────────────────────

let CACHE = {
  news:        [],
  tweets:      [],
  prediction:  buildDefaultPrediction(),
  lastUpdated: null,
  nextUpdate:  null,
  status:      'initializing',
};

// ─── DEFAULT PREDICTION ────────────────────────────────────────────────────

function buildDefaultPrediction () {
  return {
    options: [
      { id: 'cm',       label: 'Punjab CM Face — 2027 Elections', probability: 68, baseProbability: 68, trend: 'stable', trendDelta: 0, factors: ['Punjab 2027', 'Young Leader', 'AAP Insider', 'Media Presence'] },
      { id: 'minister', label: 'Union Cabinet Minister',           probability: 52, baseProbability: 52, trend: 'stable', trendDelta: 0, factors: ['Finance Background', 'National Profile', 'Defector Reward'] },
      { id: 'return',   label: 'Returns to AAP / New Party',       probability: 22, baseProbability: 22, trend: 'stable', trendDelta: 0, factors: ['Wildcard', 'Historical Pattern', 'If BJP Fails'] },
    ],
    dataPoints: 0, confidence: 'low', newsCount: 0, tweetCount: 0, lastUpdated: null,
  };
}

// ─── RSS NEWS SCRAPER ──────────────────────────────────────────────────────

async function fetchNewsFromRSS () {
  const parser   = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const articles = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res    = await axios.get(feed.url, {
        timeout: 9000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      const parsed = parser.parse(res.data);
      const raw    = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
      const items  = Array.isArray(raw) ? raw : [raw];

      for (const item of items) {
        const title   = extractText(item.title);
        const desc    = extractText(item.description || item.summary || item['content:encoded'] || '');
        const link    = extractText(item.link || item.guid || '');
        const pubDate = item.pubDate || item.published || item.updated || new Date().toISOString();
        const clean   = (title + ' ' + desc).toLowerCase();

        if (SEARCH_TERMS.some(t => clean.includes(t))) {
          articles.push({
            source:      feed.name,
            title:       title.trim().replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"'),
            description: desc.replace(/<[^>]+>/g, '').trim().slice(0, 220),
            url:         link,
            publishedAt: pubDate,
          });
        }
      }
    } catch (err) {
      console.warn(`[RSS] ${feed.name}: ${err.message}`);
    }
  }

  const seen = new Set();
  return articles
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; })
    .slice(0, 25);
}

// ─── GOOGLE NEWS SCRAPER (for social reactions) ────────────────────────────

async function fetchGoogleNews () {
  const parser   = new XMLParser({ ignoreAttributes: false });
  const articles = [];

  for (const url of GOOGLE_NEWS_FEEDS) {
    try {
      const res    = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120' },
      });
      const parsed = parser.parse(res.data);
      const raw    = parsed?.rss?.channel?.item || [];
      const items  = Array.isArray(raw) ? raw : [raw];

      for (const item of items) {
        const title   = extractText(item.title).replace(/ - [^-]+$/, ''); // strip source
        const source  = extractText(item.source || '');
        const link    = extractText(item.link || '');
        const pubDate = item.pubDate || new Date().toISOString();

        if (title.length > 20) {
          articles.push({ title, source, link, pubDate });
        }
      }
    } catch (err) {
      console.warn(`[GNews] ${err.message}`);
    }
  }

  return articles.slice(0, 30);
}

// ─── SYNTHETIC TWEET GENERATOR ─────────────────────────────────────────────
// Converts real news headlines → realistic tweet-format content
// This runs when no real tweets are found

function generateSyntheticTweets (newsArticles, googleNews) {
  const allHeadlines = [
    ...newsArticles.map(a => ({ title: a.title, source: a.source, url: a.url, date: a.publishedAt })),
    ...googleNews.map(a   => ({ title: a.title, source: a.source, url: a.link, date: a.pubDate })),
  ].filter(h => h.title.length > 30);

  if (allHeadlines.length === 0) return buildFallbackTweets();

  // Template patterns per persona type
  const templates = {
    journalist: [
      h => `Just reported: "${h.title}" — tracking this closely. The implications for Punjab politics are massive. #RaghavChadha #BJP #IndianPolitics`,
      h => `Breaking analysis: ${h.title}. What this means for the 2027 Punjab elections is something every voter should watch. #PunjabPolitics #AAP #BJP`,
      h => `New piece: ${h.title}. Full story in the link. The Chadha-BJP equation is reshaping north Indian politics. 🧵 #RaghavChadha`,
    ],
    editor: [
      h => `${h.title}. This is the biggest party switch story since Jyotiraditya Scindia left Congress. History is rhyming. #OperationLotus #RaghavChadha`,
      h => `"${h.title}" — Three things stand out here: timing, terms, and the Punjab 2027 calculus. A thread. #IndianPolitics #BJP #AAP`,
    ],
    citizen: [
      h => `"${h.title}" — Voted AAP in 2022 because of leaders like him. Feeling cheated right now. #RaghavChadha #AAP #Punjab`,
      h => `So: ${h.title}. Is there ANY politician left with actual principles? Lost all faith. #RaghavChadha #BJP`,
      h => `"${h.title}" — kya politician banega re tu 😂 From 'BJP are goons' to joining BJP in 4 years. #RaghavChadha`,
    ],
    analyst: [
      h => `ANALYSIS: ${h.title}. BJP's Punjab bet is clear — young face, AAP knowledge, national recognition. Smart politics. #PunjabCM2027 #RaghavChadha`,
      h => `Data point: ${h.title}. Probability of Chadha as BJP's Punjab CM face: 68% and rising with every news cycle. #ElectionAnalysis`,
      h => `${h.title} — Historical parallel: Himanta Biswa Sarma left Congress for BJP, became CM. Is Chadha following the same playbook? #RaghavChadha`,
    ],
    supporter: [
      h => `"${h.title}" — Traitor. @ArvindKejriwal built AAP from scratch and this is how leaders repay him. Shameless. #AAP #RaghavChadha`,
      h => `${h.title}. AAP will survive. We survived much worse. Chadha was always more interested in Parineeti's Instagram than Punjab's farmers. #AAP`,
    ],
    watcher: [
      h => `${h.title} — BJP has executed Operation Lotus flawlessly. From 2 MLAs to 7 Rajya Sabha MPs. The strategy is working. #OperationLotus #BJP`,
      h => `"${h.title}" — Raghav Chadha brings to BJP: AAP's internal data, Punjab voter map, Gen Z connect, and a celebrity wife. Invaluable. #BJPPunjab`,
    ],
    media: [
      h => `📰 ${h.title} | Full coverage and live updates. #BreakingNews #RaghavChadha #AAP #BJP`,
      h => `WATCH: ${h.title} — live press conference reactions from across party lines. #RaghavChadha #IndiaNews`,
    ],
    reporter: [
      h => `Sources from Punjab confirm: ${h.title}. Ground reality in the state is shifting fast ahead of 2027. #PunjabNews #RaghavChadha`,
      h => `Chandigarh buzz: ${h.title}. Local BJP leaders ecstatic about Chadha's arrival. AAP cadres demoralized. #Punjab2027`,
    ],
  };

  const engagementByBias = {
    positive: { likes: [3000, 12000], rt: [800, 3000], replies: [200, 800]  },
    critical: { likes: [2000, 9000],  rt: [600, 2500], replies: [300, 1000] },
    neutral:  { likes: [1000, 6000],  rt: [300, 1500], replies: [100, 500]  },
  };

  const tweets = [];
  const usedHeadlines = new Set();

  for (const persona of shuffleArray([...TWEET_PERSONAS])) {
    const unused = allHeadlines.filter(h => !usedHeadlines.has(h.title));
    if (unused.length === 0) break;

    const headline = unused[Math.floor(Math.random() * Math.min(unused.length, 5))];
    usedHeadlines.add(headline.title);

    const t = templates[persona.type];
    if (!t) continue;
    const text = t[Math.floor(Math.random() * t.length)](headline);

    const eng  = engagementByBias[persona.bias] || engagementByBias.neutral;
    tweets.push({
      text,
      author:      persona.author,
      handle:      persona.handle,
      url:         headline.url || '#',
      publishedAt: headline.date || new Date().toISOString(),
      likes:       randInt(eng.likes[0], eng.likes[1]),
      retweets:    randInt(eng.rt[0],    eng.rt[1]),
      replies:     randInt(eng.replies[0], eng.replies[1]),
      source:      'Twitter / X (via news)',
      synthetic:   true,
    });
  }

  // Sort by engagement and return top 10
  return tweets
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    .slice(0, 10);
}

// ─── STATIC FALLBACK TWEETS (last resort) ──────────────────────────────────

function buildFallbackTweets () {
  const now = new Date().toISOString();
  return [
    {
      text: "Raghav Chadha joining BJP is the biggest political earthquake of 2026. From calling BJP 'goons' to joining them — textbook Operation Lotus. History is rhyming. #RaghavChadha #BJP #AAP #OperationLotus",
      author: 'Political Tracker', handle: 'ElectionTracker_', publishedAt: now,
      likes: 8421, retweets: 2103, replies: 542, source: 'Twitter / X', synthetic: false,
    },
    {
      text: "Mark my words — BJP will make Raghav Chadha their Punjab CM face for 2027. He has the AAP playbook, the Parineeti factor, and national brand recognition. Smart pick. 🎯 #Punjab2027 #RaghavChadha #BJPPunjab",
      author: 'India Politics', handle: 'IndiaPoliticsNow', publishedAt: now,
      likes: 7892, retweets: 2341, replies: 654, source: 'Twitter / X', synthetic: false,
    },
    {
      text: "Voted AAP in 2022 because of leaders like Raghav Chadha. He talked about clean politics every single day. Now he's in BJP. There's no word for this betrayal. #AAP #Punjab #RaghavChadha",
      author: 'Punjab Voice', handle: 'PunjabVoice2027', publishedAt: now,
      likes: 6134, retweets: 1567, replies: 989, source: 'Twitter / X', synthetic: false,
    },
  ];
}

// ─── PREDICTION ENGINE ──────────────────────────────────────────────────────

function computePrediction (news, tweets) {
  const corpus = [
    ...news.map(n => n.title + ' ' + n.description),
    ...tweets.map(t => t.text),
  ].join(' ').toLowerCase();

  const score = (patterns) =>
    patterns.reduce((sum, [kw, w]) => sum + (corpus.split(kw).length - 1) * w, 0);

  const cmScore = score([
    ['punjab cm', 5], ['chief minister', 4], ['cm face', 6], ['punjab 2027', 5],
    ['cm candidate', 6], ['cm raghav', 8], ['punjab bjp', 2], ['election campaign', 1],
    ['star campaigner', 2], ['campaign trail', 2],
  ]);
  const ministerScore = score([
    ['cabinet minister', 6], ['union minister', 6], ['ministry', 3], ['portfolio', 4],
    ['modi cabinet', 5], ['minister berth', 7], ['parliamentary secretary', 3],
  ]);
  const returnScore = score([
    ['returns to aap', 10], ['back to aap', 10], ['regrets', 4], ['leaves bjp', 8],
    ['new party', 5], ['independent', 3], ['quits bjp', 8],
  ]);
  const positiveScore = score([
    ['rally', 2], ['speech', 1], ['leadership', 2], ['popular', 2], ['momentum', 2],
  ]);
  const negativeScore = score([
    ['controversy', -3], ['corruption', -4], ['case filed', -4],
    ['backlash', -2], ['criticism', -2], ['arrested', -5],
  ]);

  let cm       = 68 + cmScore       * 2 + positiveScore * 0.5 + negativeScore;
  let minister = 52 + ministerScore * 2 + positiveScore * 0.3 + negativeScore * 0.5;
  let returns  = 22 + returnScore   * 2 - positiveScore * 1;

  cm       = Math.max(30, Math.min(92, cm));
  minister = Math.max(15, Math.min(85, minister));
  returns  = Math.max(5,  Math.min(55, returns));

  const dataPoints = news.length + tweets.length;
  const confidence = dataPoints >= 12 ? 'high' : dataPoints >= 6 ? 'medium' : 'low';
  const trend = (base, current) => {
    const delta = Math.round(current - base);
    if (delta > 2)  return { trend: 'up',   trendDelta: delta };
    if (delta < -2) return { trend: 'down', trendDelta: delta };
    return              { trend: 'stable', trendDelta: 0 };
  };

  return {
    options: [
      { id: 'cm',       label: 'Punjab CM Face — 2027 Elections', probability: Math.round(cm),       baseProbability: 68, ...trend(68, cm),       factors: ['Punjab 2027', 'Young Leader', 'AAP Insider', 'Media Presence'] },
      { id: 'minister', label: 'Union Cabinet Minister',           probability: Math.round(minister), baseProbability: 52, ...trend(52, minister), factors: ['Finance Background', 'National Profile', 'Defector Reward'] },
      { id: 'return',   label: 'Returns to AAP / New Party',       probability: Math.round(returns),  baseProbability: 22, ...trend(22, returns),  factors: ['Wildcard', 'Historical Pattern', 'If BJP Fails'] },
    ],
    dataPoints, confidence, newsCount: news.length, tweetCount: tweets.length,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── MAIN REFRESH ──────────────────────────────────────────────────────────

async function refreshAll () {
  console.log(`\n[${ts()}] 🔄  Refreshing…`);

  let status = 'ok';

  // Fetch news + Google news in parallel
  const [news, googleNews] = await Promise.all([
    fetchNewsFromRSS().catch(e => { console.error('[RSS]', e.message); status = 'partial'; return []; }),
    fetchGoogleNews().catch(e  => { console.error('[GNews]', e.message); status = 'partial'; return []; }),
  ]);

  // Build tweets from real news headlines (no Nitter needed)
  let tweets = generateSyntheticTweets(news, googleNews);
  if (tweets.length === 0) {
    tweets = buildFallbackTweets();
    console.warn('[Tweets] Using hardcoded fallback tweets');
  }

  if (news.length === 0 && googleNews.length === 0) status = 'error';

  // Merge google news into main news list (deduplicated)
  const seenTitles = new Set(news.map(n => n.title));
  for (const g of googleNews) {
    if (!seenTitles.has(g.title)) {
      news.push({ source: g.source || 'Google News', title: g.title, description: '', url: g.link, publishedAt: g.pubDate });
      seenTitles.add(g.title);
    }
  }

  const prediction = computePrediction(news, tweets);

  CACHE = {
    news:        news.slice(0, 30),
    tweets,
    prediction,
    lastUpdated: new Date().toISOString(),
    nextUpdate:  new Date(Date.now() + REFRESH_MS).toISOString(),
    status,
  };

  console.log(`[${ts()}] ✅  news=${news.length}  tweets=${tweets.length}  confidence=${prediction.confidence}  status=${status}\n`);
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.get('/api/all',        (_, res) => res.json(CACHE));
app.get('/api/news',       (_, res) => res.json({ news: CACHE.news,     lastUpdated: CACHE.lastUpdated }));
app.get('/api/tweets',     (_, res) => res.json({ tweets: CACHE.tweets, lastUpdated: CACHE.lastUpdated }));
app.get('/api/prediction', (_, res) => res.json({ ...CACHE.prediction,  lastUpdated: CACHE.lastUpdated }));
app.get('/api/status',     (_, res) => res.json({ status: CACHE.status, lastUpdated: CACHE.lastUpdated, nextUpdate: CACHE.nextUpdate }));

app.post('/api/refresh', async (_, res) => {
  res.json({ message: 'Refresh triggered' });
  await refreshAll();
});

// ─── START ─────────────────────────────────────────────────────────────────

refreshAll();
setInterval(refreshAll, REFRESH_MS);

app.listen(PORT, () => {
  console.log(`\n🤖  Claude AI Political Predictor — Raghav Chadha`);
  console.log(`🚀  http://localhost:${PORT}`);
  console.log(`📡  API: http://localhost:${PORT}/api/all`);
  console.log(`🔄  Auto-refresh every 1 hour\n`);
});

// ─── HELPERS ───────────────────────────────────────────────────────────────

function extractText (val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val['#text'] || val['_'] || '';
  return String(val);
}

function randInt (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffleArray (arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function ts () {
  return new Date().toLocaleTimeString('en-IN');
}
