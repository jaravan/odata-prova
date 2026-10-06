using my from './schema';
service CatalogService {
  @odata.draft.enabled
  entity Books as projection on my.Books;
  entity Chapters as projection on my.Chapters;
  entity Authors as projection on my.Authors;
}
