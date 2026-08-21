import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiMetadata, parseArxivIdentifier, parseCategoryTaxonomy, parseRss } from '../src/arxiv.js';

test('parses modern and legacy arXiv identifiers', () => {
  assert.deepEqual(parseArxivIdentifier('oai:arXiv.org:2508.12345v3'), { id: '2508.12345', version: 3 });
  assert.deepEqual(parseArxivIdentifier('https://arxiv.org/abs/hep-th/9901001v2'), { id: 'hep-th/9901001', version: 2 });
  assert.equal(parseArxivIdentifier('not-an-id'), null);
});

test('parses arXiv RSS items and isolates abstract text', () => {
  const feed = parseRss(`<?xml version="1.0"?>
    <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel>
        <lastBuildDate>Thu, 20 Aug 2026 05:00:00 +0000</lastBuildDate>
        <item>
          <title>  A   useful paper </title>
          <link>https://arxiv.org/abs/2508.12345</link>
          <description>arXiv:2508.12345v2 Announce Type: replace
Abstract: The abstract.</description>
          <guid isPermaLink="false">oai:arXiv.org:2508.12345v2</guid>
          <category>cs.LG</category><category>cs.AI</category>
          <pubDate>Thu, 20 Aug 2026 00:00:00 -0400</pubDate>
          <arxiv:announce_type>replace</arxiv:announce_type>
          <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
        </item>
      </channel>
    </rss>`);
  assert.equal(feed.papers.length, 1);
  assert.equal(feed.papers[0].id, '2508.12345');
  assert.equal(feed.papers[0].version, 2);
  assert.equal(feed.papers[0].title, 'A useful paper');
  assert.equal(feed.papers[0].abstract, 'The abstract.');
  assert.deepEqual(feed.papers[0].categories, ['cs.LG', 'cs.AI']);
});

test('parses taxonomy groups without depending on descriptions', () => {
  const categories = parseCategoryTaxonomy(`${'<h2 class="accordion-head" id="accordion-head-grp_x"><button><span></span> Group X </button></h2><div id="accordion-panel-grp_x">'}
    ${Array.from({ length: 21 }, (_, index) => `<h4>x.${index} <span>(Category ${index})</span></h4>`).join('')}</div>`);
  assert.equal(categories.length, 21);
  assert.equal(categories[0].groupName, 'Group X');
});

test('parses published and latest-version timestamps from arXiv metadata', () => {
  const metadata = parseApiMetadata(`<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/2407.05788v2</id>
        <published>2024-07-08T09:49:38Z</published>
        <updated>2026-08-19T07:50:07Z</updated>
      </entry>
    </feed>`);
  assert.deepEqual(metadata, [{
    id: '2407.05788', version: 2,
    publishedAt: '2024-07-08T09:49:38.000Z',
    updatedAt: '2026-08-19T07:50:07.000Z',
  }]);
});
