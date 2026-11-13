// Fictional collection shared by native captures and website demos.
// Capture order and captureListSlug preserve the documented native fixture;
// listOrder and timelineOrder select the compact interactive views.
export const demoLists = [
  {
    slug: 'reading-list-small-web',
    name: 'Small web',
    parentSlug: null,
  },
  {
    slug: 'reading-list-design',
    name: 'Design',
    parentSlug: null,
  },
  {
    slug: 'reading-list-font',
    name: 'Font',
    parentSlug: 'reading-list-design',
  },
  {
    slug: 'reading-list-cinema',
    name: 'Cinema',
    parentSlug: null,
  },
  {
    slug: 'reading-list-writing',
    name: 'Writing',
    parentSlug: null,
  },
  {
    slug: 'reading-list-music',
    name: 'Music',
    parentSlug: null,
  },
  {
    slug: 'reading-list-drumming',
    name: 'Drumming',
    parentSlug: 'reading-list-music',
  },
  {
    slug: 'reading-list-cooking',
    name: 'Cooking',
    parentSlug: null,
  },
];

export const capturePages = [
  {
    title: 'A smaller, slower web',
    url: 'https://fieldnotes.example/a-smaller-web',
    captureListSlug: 'reading-list-small-web',
    note: 'Leave room for the unfinished things.',
    listSlugs: ['reading-list-small-web', 'reading-list-writing'],
    hasHighlightNotes: true,
    listOrder: 0,
    timelineOrder: 0,
  },
  {
    title: 'Making a home on the internet',
    url: 'https://garden.example/a-home-online',
    listSlugs: ['reading-list-small-web'],
    listOrder: 10,
  },
  {
    title: 'Good tools leave room for you',
    url: 'https://workshop.example/good-tools',
    captureListSlug: 'reading-list-design',
    listSlugs: ['reading-list-design'],
    listOrder: 5,
  },
  {
    title: 'A reading list for rainy afternoons',
    url: 'https://margin.example/reading-list',
  },
  {
    title: 'The quiet work of keeping a notebook',
    url: 'https://fieldnotes.example/notebooks',
    listSlugs: ['reading-list-writing'],
    listOrder: 19,
  },
  {
    title: 'Type that feels like a conversation',
    url: 'https://typefoundry.example/conversation',
    captureListSlug: 'reading-list-font',
    note: 'Letterforms with a little warmth.',
    listSlugs: ['reading-list-font'],
    listOrder: 2,
    timelineOrder: 2,
  },
  {
    title: 'Designing for the second visit',
    url: 'https://workshop.example/second-visit',
    listSlugs: ['reading-list-design'],
    listOrder: 13,
  },
  {
    title: 'A garden is never quite finished',
    url: 'https://garden.example/never-finished',
  },
  {
    title: 'Why I still keep a personal website',
    url: 'https://margin.example/personal-website',
    captureListSlug: 'reading-list-writing',
    listSlugs: ['reading-list-writing', 'reading-list-small-web'],
    listOrder: 7,
  },
  {
    title: 'A little space between things',
    url: 'https://typefoundry.example/white-space',
    listSlugs: ['reading-list-font'],
    listOrder: 16,
  },
  {
    title: 'How to repot a rubber plant',
    url: 'https://leaf.example/guides/rubber-plant',
  },
  {
    title: 'Lemon and white bean soup',
    url: 'https://table.example/lemon-bean-soup',
    captureListSlug: 'reading-list-cooking',
    note: 'A squeeze of lemon at the end.',
    listSlugs: ['reading-list-cooking'],
    listOrder: 3,
    timelineOrder: 3,
  },
  {
    title: 'Saturday opening hours',
    url: 'https://library.example/visit',
  },
  {
    title: 'Train times: Central to the coast',
    url: 'https://rail.example/journey/coast',
  },
  {
    title: 'A walk along the old canal',
    url: 'https://footpath.example/canal-walk',
  },
  {
    title: 'Replacing a bicycle inner tube',
    url: 'https://cycle.example/repair/inner-tube',
  },
  {
    title: 'Weekend forecast',
    url: 'https://weather.example/weekend',
  },
  {
    title: 'Ceramics open studio — September',
    url: 'https://clay.example/open-studio',
  },
  {
    title: 'A guide to paper sizes',
    url: 'https://paper.example/sizes',
    listSlugs: ['reading-list-font'],
    listOrder: 17,
  },
  {
    title: 'CSS grid: a practical reference',
    url: 'https://webdocs.example/css/grid',
  },
  {
    title: 'The bookshop on the corner',
    url: 'https://bookshop.example/about',
  },
  {
    title: 'Miso mushrooms on toast',
    url: 'https://table.example/miso-mushrooms',
    listSlugs: ['reading-list-cooking'],
    listOrder: 25,
  },
  {
    title: 'A short history of the city tram',
    url: 'https://museum.example/journal/tram',
  },
  {
    title: 'Practice a relaxed single-stroke roll',
    url: 'https://rhythm.example/single-stroke-roll',
    captureListSlug: 'reading-list-drumming',
    listSlugs: ['reading-list-drumming'],
    listOrder: 9,
  },
  {
    title: 'Repair café: what to bring',
    url: 'https://repair.example/visit',
  },
  {
    title: 'Native plants for a small balcony',
    url: 'https://leaf.example/balcony',
  },
  {
    title: 'Finding the right line height',
    url: 'https://typefoundry.example/line-height',
    listSlugs: ['reading-list-font'],
    listOrder: 15,
  },
  {
    title: 'An evening of piano music',
    url: 'https://venue.example/piano-evening',
    captureListSlug: 'reading-list-music',
    listSlugs: ['reading-list-music'],
    listOrder: 8,
  },
  {
    title: 'Map of the riverside path',
    url: 'https://footpath.example/riverside',
  },
  {
    title: 'How long does opened miso keep?',
    url: 'https://table.example/pantry/miso',
    listSlugs: ['reading-list-cooking'],
    listOrder: 27,
  },
  {
    title: 'Library catalogue — The Creative Act',
    url: 'https://library.example/catalogue/creative-act',
  },
  {
    title: 'Local swimming pool timetable',
    url: 'https://pool.example/timetable',
  },
  {
    title: 'Simple shelves for a narrow room',
    url: 'https://workshop.example/shelves',
    listSlugs: ['reading-list-design'],
    listOrder: 14,
  },
  {
    title: 'Film notes: Perfect Days',
    url: 'https://screen.example/perfect-days',
    captureListSlug: 'reading-list-cinema',
    listSlugs: ['reading-list-cinema'],
    listOrder: 6,
  },
  {
    title: 'A small desk lamp in warm white',
    url: 'https://supply.example/lighting/desk-lamp',
  },
  {
    title: 'Exhibition: drawings from the everyday',
    url: 'https://museum.example/exhibitions/drawings',
  },
  {
    title: 'An easy route home from the station',
    url: 'https://footpath.example/station-route',
  },
  {
    title: 'Roasted tomatoes with lentils',
    url: 'https://table.example/tomato-lentils',
    listSlugs: ['reading-list-cooking'],
    listOrder: 26,
  },
  {
    title: 'Community garden volunteer mornings',
    url: 'https://garden.example/volunteer',
  },
  {
    title: 'How to clean a fountain pen',
    url: 'https://paper.example/fountain-pen-care',
  },
];

const extraPages = [
  {
    title: 'A garden that grows with you',
    url: 'https://leaf.example/garden',
    note: 'Start with one pot and let curiosity take over.',
    hasHighlightNotes: true,
    listOrder: 1,
    timelineOrder: 1,
  },
  {
    title: 'Notes from the old coast path',
    url: 'https://footpath.example/coast-path',
    note: 'The path bends toward the sea.',
    hasSnapshots: true,
    listOrder: 4,
    timelineOrder: 4,
  },
  {
    title: 'The quiet art of following an RSS feed',
    url: 'https://fieldnotes.example/rss',
    listSlugs: ['reading-list-small-web'],
    listOrder: 11,
  },
  {
    title: 'A personal site without a plan',
    url: 'https://garden.example/without-a-plan',
    listSlugs: ['reading-list-small-web'],
    listOrder: 12,
  },
  {
    title: 'What a quiet film leaves behind',
    url: 'https://screen.example/quiet-films',
    listSlugs: ['reading-list-cinema'],
    listOrder: 18,
  },
  {
    title: 'Keeping a commonplace book',
    url: 'https://margin.example/commonplace-book',
    listSlugs: ['reading-list-writing'],
    listOrder: 20,
  },
  {
    title: 'Writing without a publishing calendar',
    url: 'https://fieldnotes.example/no-calendar',
    listSlugs: ['reading-list-writing'],
    listOrder: 21,
  },
  {
    title: 'Field recordings from a morning walk',
    url: 'https://rhythm.example/morning-walk',
    listSlugs: ['reading-list-music'],
    listOrder: 22,
  },
  {
    title: 'Listening to an album from start to finish',
    url: 'https://venue.example/a-whole-album',
    listSlugs: ['reading-list-music'],
    listOrder: 23,
  },
  {
    title: 'A ten-minute practice routine',
    url: 'https://rhythm.example/ten-minutes',
    listSlugs: ['reading-list-drumming'],
    listOrder: 24,
  },
  {
    title: 'Roasted squash and barley salad',
    url: 'https://table.example/squash-barley',
    listSlugs: ['reading-list-cooking'],
    listOrder: 28,
  },
];

const pages = [...capturePages, ...extraPages];
export const timelinePages = pages
  .filter((page) => page.timelineOrder !== undefined)
  .sort((a, b) => a.timelineOrder - b.timelineOrder);
export const listPages = pages
  .filter((page) => page.listOrder !== undefined)
  .sort((a, b) => a.listOrder - b.listOrder);
export const featuredPage = timelinePages[0];

function creationOrder(parentSlug = null) {
  return demoLists
    .filter((list) => list.parentSlug === parentSlug)
    .reverse()
    .flatMap((list) => [list, ...creationOrder(list.slug)]);
}
export const captureLists = creationOrder();
