/**
 * User domain model.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role?: string;
}

export class UserEntity {
  constructor(
    public readonly id: string,
    public readonly email: string,
    public readonly name: string,
    public readonly role: string
  ) {}

  toJSON(): User {
    return {
      id: this.id,
      email: this.email,
      name: this.name,
      role: this.role,
      createdAt: new Date(),
    };
  }
}
