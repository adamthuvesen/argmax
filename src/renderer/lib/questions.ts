export type QuestionOption = {
  label: string;
  description?: string;
};

export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
};
