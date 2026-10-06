namespace my;
using { cuid } from '@sap/cds/common';

entity Books : cuid {
  title    : String(111);
  stock    : Integer;
  author   : Association to Authors;
  chapters : Composition of many Chapters on chapters.book = $self;
}
entity Chapters : cuid {
  book  : Association to Books;
  title : String;
  pages : Integer;
}
entity Authors {
  key ID : Integer;
  name   : String(111);
}
