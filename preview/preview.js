const stageImage = document.querySelector('.p2md-figure-image-button img');
const stageTitle = document.querySelector('.p2md-figure-stage h3');
const counter = document.querySelector('.p2md-figure-stage-header span');
const thumbs = [...document.querySelectorAll('.p2md-thumbnail')];
const dialog = document.querySelector('#lightbox');
const dialogImage = dialog.querySelector('img');

thumbs.forEach((thumb, index) => {
  thumb.addEventListener('click', () => {
    thumbs.forEach((item) => item.dataset.selected = 'false');
    thumb.dataset.selected = 'true';
    stageImage.src = thumb.dataset.src;
    stageTitle.textContent = `Figure ${index + 1}`;
    counter.textContent = `${index + 1} / ${thumbs.length}`;
  });
});

document.querySelectorAll('[data-lightbox]').forEach((button) => button.addEventListener('click', () => {
  dialogImage.src = stageImage.src;
  dialog.showModal();
}));
dialog.querySelector('button').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
