// The fixture's covers hook: the play shot taps the canvas once, so the page draws its mid-play frame.
export async function capture(page, shot) {
  if (shot.id === 'play') await page.mouse.click(10, 10);
}
