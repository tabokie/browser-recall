// Original, fictional reading material. No personal history or external pages.
const documentationDevice = 'reading-desk';
const day = 86400000;
const base = Date.parse('2026-09-16T08:00:00Z');
const pages = [
  [
    'A smaller, slower web',
    'https://fieldnotes.example/a-smaller-web',
    'Small web',
  ],
  [
    'Making a home on the internet',
    'https://garden.example/a-home-online',
    'Small web',
  ],
  [
    'Good tools leave room for you',
    'https://workshop.example/good-tools',
    'Small web',
  ],
  [
    'A reading list for rainy afternoons',
    'https://margin.example/reading-list',
    'Weekend reading',
  ],
  [
    'The quiet work of keeping a notebook',
    'https://fieldnotes.example/notebooks',
  ],
  [
    'Type that feels like a conversation',
    'https://typefoundry.example/conversation',
    'Design details',
  ],
  ['Designing for the second visit', 'https://workshop.example/second-visit'],
  ['A garden is never quite finished', 'https://garden.example/never-finished'],
  [
    'Why I still keep a personal website',
    'https://margin.example/personal-website',
    'Small web',
  ],
  ['A little space between things', 'https://typefoundry.example/white-space'],
  ['How to repot a rubber plant', 'https://leaf.example/guides/rubber-plant'],
  ['Lemon and white bean soup', 'https://table.example/lemon-bean-soup'],
  ['Saturday opening hours', 'https://library.example/visit'],
  ['Train times: Central to the coast', 'https://rail.example/journey/coast'],
  ['A walk along the old canal', 'https://footpath.example/canal-walk'],
  ['Replacing a bicycle inner tube', 'https://cycle.example/repair/inner-tube'],
  ['Weekend forecast', 'https://weather.example/weekend'],
  ['Ceramics open studio — September', 'https://clay.example/open-studio'],
  ['A guide to paper sizes', 'https://paper.example/sizes'],
  ['CSS grid: a practical reference', 'https://webdocs.example/css/grid'],
  ['The bookshop on the corner', 'https://bookshop.example/about'],
  ['Miso mushrooms on toast', 'https://table.example/miso-mushrooms'],
  ['A short history of the city tram', 'https://museum.example/journal/tram'],
  ['Coffee filters, size 02', 'https://supply.example/coffee/filters'],
  ['Repair café: what to bring', 'https://repair.example/visit'],
  ['Native plants for a small balcony', 'https://leaf.example/balcony'],
  ['Finding the right line height', 'https://typefoundry.example/line-height'],
  ['An evening of piano music', 'https://venue.example/piano-evening'],
  ['Map of the riverside path', 'https://footpath.example/riverside'],
  ['How long does opened miso keep?', 'https://table.example/pantry/miso'],
  [
    'Library catalogue — The Creative Act',
    'https://library.example/catalogue/creative-act',
  ],
  ['Local swimming pool timetable', 'https://pool.example/timetable'],
  ['Simple shelves for a narrow room', 'https://workshop.example/shelves'],
  ['Film notes: Perfect Days', 'https://screen.example/perfect-days'],
  [
    'A small desk lamp in warm white',
    'https://supply.example/lighting/desk-lamp',
  ],
  [
    'Exhibition: drawings from the everyday',
    'https://museum.example/exhibitions/drawings',
  ],
  [
    'An easy route home from the station',
    'https://footpath.example/station-route',
  ],
  ['Roasted tomatoes with lentils', 'https://table.example/tomato-lentils'],
  ['Community garden volunteer mornings', 'https://garden.example/volunteer'],
  ['How to clean a fountain pen', 'https://paper.example/fountain-pen-care'],
];

export function documentationSeed() {
  const events = [];
  for (const [index, name] of [
    'Small web',
    'Weekend reading',
    'Design details',
  ].entries()) {
    events.push({
      action: 'create_list',
      timestamp: base - 15 * day + index,
      name,
      listOwner: documentationDevice,
      listId: `reading-list-${index}`,
      parentListId: null,
    });
  }
  function visit(pageIndex, timestamp, duration) {
    const [title, url] = pages[pageIndex];
    events.push(
      { action: 'visit_page', timestamp, url, title, referrerUrl: null },
      {
        action: 'leave_page',
        timestamp: timestamp + duration,
        url,
        title,
        scrollDepth: 15 + ((pageIndex * 17) % 86),
        timeOnPage: duration,
      },
    );
  }
  // Every page is actually visited. Uneven sessions mix reading with everyday errands.
  for (const [index, [title, url, list]] of pages.entries()) {
    const timestamp =
      base - (2 + (index % 12)) * day + ((index * 137) % 540) * 60000;
    visit(index, timestamp, (23 + ((index * 47) % 430)) * 1000);
    if (list)
      events.push({
        action: 'pin_to_list',
        timestamp: timestamp + 500000,
        name: list,
        listOwner: documentationDevice,
        urls: [url],
        titles: [title],
        source: 'manual',
      });
  }
  // Descending Timeline order puts both saved pages first in the compact capture.
  const recent = [12, 29, 19, 24, 11, 14, 16, 30, 10, 37, 8, 0];
  const minutes = [8, 14, 39, 51, 87, 126, 132, 171, 184, 225, 247, 281];
  recent.forEach((pageIndex, index) =>
    visit(
      pageIndex,
      base + minutes[index] * 60000,
      (31 + ((index * 83) % 390)) * 1000,
    ),
  );

  const highlights = [
    [
      0,
      0,
      175,
      'A personal website can be a place to think out loud. Leave room for the unfinished things: a photograph from a walk, a question you cannot answer, a list that only makes sense to you. Over time, those small pieces begin to describe a life more honestly than a carefully written introduction ever could.',
      'Leave the unfinished bits in.',
    ],
    [0, 0, 172, 'You do not have to publish on a schedule.', null],
    [
      2,
      1,
      231,
      'A good tool leaves room for you.',
      'This is what bothered me about the last redesign. Every empty space became a prompt to do something. For the next version, I want to leave a few quiet places where a person can pause, look around, and decide what matters to them.',
    ],
    [
      2,
      1,
      228,
      'A familiar object asks less of us each time we use it. The handle sits where the hand expects it to be.',
      null,
    ],
    [
      4,
      3,
      65,
      'I used to save only the sentences that sounded complete. Now I keep the awkward questions too. A notebook is useful precisely because it can hold a thought before I know what to do with it.',
      null,
    ],
    [4, 3, 62, 'Some ideas need to be met twice.', null],
    [
      0,
      0,
      170,
      'The pages I return to rarely try to hold my attention. They offer something particular, then let me go: a recipe with a handwritten correction, a photograph of the same tree in another season.',
      null,
    ],
    [
      2,
      1,
      225,
      'We notice care in the small decisions. A drawer opens without catching. A label says what we need to know. Nothing announces itself, but the whole afternoon becomes a little easier because someone paid attention.',
      null,
    ],
    [
      4,
      3,
      63,
      'Reading an old notebook is a conversation with someone almost familiar. I recognize the handwriting before I remember the worry. Between the shopping lists and borrowed sentences, there is usually one small thing I am glad I did not lose.',
      null,
    ],
  ];
  for (const [
    index,
    [pageIndex, daysAgo, minute, excerpt, note],
  ] of highlights.entries()) {
    const [title, url] = pages[pageIndex];
    const timestamp = base - daysAgo * day + minute * 60000;
    // Source visits precede the highlights, including the older reading sessions.
    visit(pageIndex, timestamp - 180000, 210000);
    events.push({
      action: 'create_note',
      timestamp,
      url,
      title,
      path: `objects/notes/reading-note-${index}.json`,
      excerpt: [excerpt],
      cssPath: [`article > p:nth-of-type(${index + 1})`],
      note,
    });
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return {
    events,
    deviceId: documentationDevice,
    settings: { theme: 'light', colorScheme: 'amber', localeOverride: 'en' },
  };
}
