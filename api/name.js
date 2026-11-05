import { createClient } from '@supabase/supabase-js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODEL = process.env.OPENAI_MODEL || 'deepseek-ai/DeepSeek-V3';

// 使用硅基流动（SiliconFlow）的 OpenAI 兼容接口
const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';

const genderMap = { male: '男性', female: '女性', neutral: '中性' };
const styleMap = {
  traditional: '传统古典',
  modern: '现代时尚',
  literary: '文艺书卷',
  heroic: '大气磅礴',
  cute: '可爱俏皮'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 未配置' });
  }

  const { gender, style, meaning } = req.body || {};
  const quantity = 3;

  const prompt = `请为我生成 ${quantity} 组中文名字，每组包含 3 个可选名字，共 ${quantity * 3} 个名字。
性别偏好：${genderMap[gender] || '不限'}
风格偏好：${styleMap[style] || '不限'}
寓意要求：${meaning || '无特殊要求'}

请以严格的 JSON 格式返回，结构如下：
{
  "groups": [
    {
      "theme": "这一组的主题/灵感来源",
      "names": [
        { "name": "名字", "pinyin": "拼音", "meaning": "寓意解释", "source": "出处" }
      ]
    }
  ]
}

只返回 JSON，不要任何 markdown 或其他文字。`;

  try {
    const aiResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: '你是一位精通中国文化、诗词典故和姓名学的起名大师，能根据用户需求创作出优美、独特且富有深意的中文名字。'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.9,
        max_tokens: 1500,
        stream: true
      })
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      return res.status(aiResponse.status).json({ error: `AI 调用失败: ${errText}` });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullContent = '';
    const reader = aiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    let parsedData = null;
    try {
      const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
      parsedData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(fullContent);
    } catch {
      parsedData = null;
    }

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { error } = await supabase.from('name_generations').insert({
          gender: gender || null,
          style: style || null,
          meaning: meaning || '',
          model: MODEL,
          quantity,
          result: parsedData || { raw: fullContent },
          created_at: new Date().toISOString()
        });
        if (error) console.error('Supabase insert error:', error);
      } catch (e) {
        console.error('Supabase error:', e.message);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || '服务器内部错误' });
    }
    try {
      res.write(`data: ${JSON.stringify({ error: error.message || '生成中断' })}\n\n`);
      res.end();
    } catch {
      // 客户端已断开，忽略
    }
  }
}
