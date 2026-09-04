import { describe, expect, it } from 'vitest';
import { matchesMenuQuery, menuSearchTerms } from '../src/menu-search.js';
import { DEMO_RESTAURANT_ID, MemoryStore } from '../src/store.js';

describe('Menu search', () => {
  it('drops the words the customer says around the product name', () => {
    expect(menuSearchTerms('una pizza margherita')).toEqual(['margherita']);
    expect(menuSearchTerms('vorrei prendere due diavole')).toEqual(['due', 'diavole']);
  });

  it('keeps searching for something when the request is only filler', () => {
    expect(menuSearchTerms('pizza')).toEqual(['pizza']);
    expect(menuSearchTerms('ok')).toEqual(['ok']);
    expect(menuSearchTerms('   ')).toEqual([]);
  });

  it('finds the product the way the customer names it', async () => {
    const store = new MemoryStore();
    expect(await store.getMenu(DEMO_RESTAURANT_ID, 'pizza margherita')).toHaveLength(1);
    expect(await store.getMenu(DEMO_RESTAURANT_ID, 'margherita')).toHaveLength(1);
  });

  it('still finds nothing for a product that does not exist', async () => {
    const store = new MemoryStore();
    expect(await store.getMenu(DEMO_RESTAURANT_ID, 'pizza kebab')).toHaveLength(0);
    expect(matchesMenuQuery({ name: 'Margherita' }, 'kebab')).toBe(false);
  });
});
